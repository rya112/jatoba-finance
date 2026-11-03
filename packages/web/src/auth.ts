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

export const SESSION_DAYS = 30;

/** Sessões ficam no banco só como hash do token: quem ler o banco não consegue entrar. */
export interface SessionStore {
  create(token: string, expiresAt: Date): Promise<void>;
  isValid(token: string): Promise<boolean>;
  delete(token: string): Promise<void>;
  purgeExpired(): Promise<number>;
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly sql: Sql) {}

  async create(token: string, expiresAt: Date): Promise<void> {
    await this.sql`insert into sessions (token_hash, expires_at) values (${sha256(token)}, ${expiresAt})`;
  }

  async isValid(token: string): Promise<boolean> {
    const rows = await this.sql`select 1 from sessions where token_hash = ${sha256(token)} and expires_at > now()`;
    return rows.length > 0;
  }

  async delete(token: string): Promise<void> {
    await this.sql`delete from sessions where token_hash = ${sha256(token)}`;
  }

  async purgeExpired(): Promise<number> {
    const result = await this.sql`delete from sessions where expires_at <= now()`;
    return result.count;
  }
}

/** Versão em memória, para testes. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Date>();

  async create(token: string, expiresAt: Date): Promise<void> {
    this.sessions.set(token, expiresAt);
  }

  async isValid(token: string): Promise<boolean> {
    const expiresAt = this.sessions.get(token);
    return expiresAt !== undefined && expiresAt.getTime() > Date.now();
  }

  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async purgeExpired(): Promise<number> {
    let count = 0;
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt.getTime() <= Date.now()) {
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
