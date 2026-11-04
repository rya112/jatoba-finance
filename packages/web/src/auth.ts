import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Sql } from "@jatoba/core";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Confere usuário e senha sem guardar a senha em texto: na partida ela vira um hash scrypt
 * com sal aleatório, e cada tentativa é comparada em tempo constante.
 */
export class Credentials {
  private constructor(
    private readonly userDigest: Buffer,
    private readonly salt: Buffer,
    private readonly passwordHash: Buffer,
  ) {}

  static async create(user: string, password: string): Promise<Credentials> {
    const salt = randomBytes(16);
    return new Credentials(sha256(user), salt, await scryptAsync(password, salt, 32));
  }

  async verify(user: string, password: string): Promise<boolean> {
    // Calcula o scrypt mesmo com usuário errado, para não revelar pelo tempo qual dos dois errou.
    const attempt = await scryptAsync(password, this.salt, 32);
    const userOk = timingSafeEqual(sha256(user), this.userDigest);
    const passwordOk = timingSafeEqual(attempt, this.passwordHash);
    return userOk && passwordOk;
  }
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface SessionLimits {
  /** Expira depois deste tempo sem uso. */
  idleMinutes: number;
  /** Expira depois deste tempo desde o login, mesmo em uso. */
  maxHours: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = { idleMinutes: 60, maxHours: 12 };

/**
 * Sessões ficam no banco só como hash do token: quem ler o banco não consegue entrar.
 * Cada sessão expira pelo que vier primeiro: inatividade ou tempo máximo desde o login.
 */
export interface SessionStore {
  /** Cria a sessão e devolve quando ela expira de qualquer jeito (tempo máximo). */
  create(token: string): Promise<Date>;
  /** A sessão vale? Se valer, conta como uso (renova a inatividade). */
  touch(token: string): Promise<boolean>;
  delete(token: string): Promise<void>;
  purgeExpired(): Promise<number>;
}

export class PgSessionStore implements SessionStore {
  constructor(
    private readonly sql: Sql,
    private readonly limits: SessionLimits = DEFAULT_SESSION_LIMITS,
  ) {}

  async create(token: string): Promise<Date> {
    const expiresAt = new Date(Date.now() + this.limits.maxHours * 60 * 60_000);
    await this.sql`insert into sessions (token_hash, expires_at) values (${sha256(token)}, ${expiresAt})`;
    return expiresAt;
  }

  async touch(token: string): Promise<boolean> {
    const rows = await this.sql`
      update sessions set last_seen_at = now()
      where token_hash = ${sha256(token)}
        and expires_at > now()
        and last_seen_at > now() - ${this.limits.idleMinutes}::int * interval '1 minute'
      returning 1`;
    return rows.length > 0;
  }

  async delete(token: string): Promise<void> {
    await this.sql`delete from sessions where token_hash = ${sha256(token)}`;
  }

  async purgeExpired(): Promise<number> {
    const result = await this.sql`
      delete from sessions
      where expires_at <= now() or last_seen_at <= now() - ${this.limits.idleMinutes}::int * interval '1 minute'`;
    return result.count;
  }

  /**
   * Se o usuário ou a senha do .env mudaram desde a última partida, derruba todas as sessões.
   * Guarda só um hash scrypt (com sal aleatório) do par usuário/senha, nunca a senha.
   * Devolve quantas sessões foram derrubadas.
   */
  async revokeIfCredentialsChanged(user: string, password: string): Promise<number> {
    const [salt] = await this.sql<{ value: Buffer }[]>`select value from app_state where key = 'credential_salt'`;
    const saltBytes = salt?.value ?? randomBytes(16);
    const tag = await scryptAsync(`${user}\u0000${password}`, saltBytes, 32);
    const [stored] = await this.sql<{ value: Buffer }[]>`select value from app_state where key = 'credential_tag'`;
    if (stored && timingSafeEqual(Buffer.from(stored.value), tag)) return 0;
    return this.sql.begin(async (tx) => {
      const removed = stored ? (await tx`delete from sessions`).count : 0;
      await tx`insert into app_state (key, value) values ('credential_salt', ${saltBytes}), ('credential_tag', ${tag})
        on conflict (key) do update set value = excluded.value`;
      return removed;
    });
  }
}

/** Versão em memória, para testes. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { expiresAt: number; lastSeen: number }>();

  constructor(
    private readonly limits: SessionLimits = DEFAULT_SESSION_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  async create(token: string): Promise<Date> {
    const expiresAt = this.now() + this.limits.maxHours * 60 * 60_000;
    this.sessions.set(token, { expiresAt, lastSeen: this.now() });
    return new Date(expiresAt);
  }

  private alive(s: { expiresAt: number; lastSeen: number }): boolean {
    const now = this.now();
    return s.expiresAt > now && s.lastSeen > now - this.limits.idleMinutes * 60_000;
  }

  async touch(token: string): Promise<boolean> {
    const s = this.sessions.get(token);
    if (!s || !this.alive(s)) return false;
    s.lastSeen = this.now();
    return true;
  }

  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async purgeExpired(): Promise<number> {
    let count = 0;
    for (const [token, s] of this.sessions) {
      if (!this.alive(s)) {
        this.sessions.delete(token);
        count++;
      }
    }
    return count;
  }
}

/** Bloqueia um endereço depois de muitas senhas erradas seguidas. */
export class LoginLimiter {
  private readonly entries = new Map<string, { failures: number; firstFailure: number; blockedUntil: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly blockMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milissegundos até poder tentar de novo; 0 se pode tentar agora. */
  retryAfter(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - this.now());
  }

  fail(key: string): void {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.firstFailure > this.windowMs) {
      entry = { failures: 0, firstFailure: now, blockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures++;
    if (entry.failures >= this.maxFailures) {
      entry.blockedUntil = now + this.blockMs;
      entry.failures = 0;
      entry.firstFailure = now;
    }
    this.cleanup(now);
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  private cleanup(now: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil < now && now - entry.firstFailure > this.windowMs) this.entries.delete(key);
    }
  }
}
