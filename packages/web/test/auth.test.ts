import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, migrate, type Sql } from "@jatoba/core";
import { Credentials, LoginLimiter, MemorySessionStore, PgSessionStore, newSessionToken, sha256 } from "../src/auth.js";
import { freshDatabase, TEST_DATABASE_URL } from "../../core/test/helpers/database.js";

describe("Credentials", () => {
  it("aceita só o usuário e a senha certos", async () => {
    const credentials = await Credentials.create("ricardo", "uma-frase-bem-longa-de-teste");
    expect(await credentials.verify("ricardo", "uma-frase-bem-longa-de-teste")).toBe(true);
    expect(await credentials.verify("ricardo", "uma-frase-bem-longa-de-tesTE")).toBe(false);
    expect(await credentials.verify("outro", "uma-frase-bem-longa-de-teste")).toBe(false);
    expect(await credentials.verify("", "")).toBe(false);
  });
});

describe("newSessionToken", () => {
  it("gera tokens longos e diferentes", () => {
    const a = newSessionToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(newSessionToken()).not.toBe(a);
  });
});

describe("LoginLimiter", () => {
  it("bloqueia depois de 5 erros e libera depois do tempo", () => {
    let now = 0;
    const limiter = new LoginLimiter(5, 60_000, 60_000, () => now);
    for (let i = 0; i < 4; i++) limiter.fail("ip");
    expect(limiter.retryAfter("ip")).toBe(0);
    limiter.fail("ip");
    expect(limiter.retryAfter("ip")).toBe(60_000);
    expect(limiter.retryAfter("outro-ip")).toBe(0);
    now = 60_001;
    expect(limiter.retryAfter("ip")).toBe(0);
  });

  it("um acerto zera os erros", () => {
    const limiter = new LoginLimiter(2);
    limiter.fail("ip");
    limiter.succeed("ip");
    limiter.fail("ip");
    expect(limiter.retryAfter("ip")).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PgSessionStore", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("sessions");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("cria, valida, expira e apaga sessões, guardando só o hash", async () => {
    await sql`delete from sessions`;
    const store = new PgSessionStore(sql, { idleMinutes: 60, maxHours: 12 });
    const valid = newSessionToken();
    const old = newSessionToken();
    const idle = newSessionToken();
    const expiresAt = await store.create(valid);
    expect(Math.abs(expiresAt.getTime() - (Date.now() + 12 * 60 * 60_000))).toBeLessThan(5_000);
    await store.create(old);
    await store.create(idle);
    // Simula: uma passou do tempo máximo; outra ficou 61 min parada.
    await sql`update sessions set expires_at = now() - interval '1 second' where token_hash = ${sha256(old)}`;
    await sql`update sessions set last_seen_at = now() - interval '61 minutes' where token_hash = ${sha256(idle)}`;

    expect(await store.touch(valid)).toBe(true);
    expect(await store.touch(old)).toBe(false);
    expect(await store.touch(idle)).toBe(false);
    expect(await store.touch(newSessionToken())).toBe(false);

    const rows = await sql<{ token_hash: Buffer }[]>`select token_hash from sessions`;
    for (const row of rows) expect(row.token_hash.toString()).not.toContain(valid);

    expect(await store.purgeExpired()).toBe(2);
    await store.delete(valid);
    expect(await store.touch(valid)).toBe(false);
  });

  it("usar a sessão renova a inatividade", async () => {
    const store = new PgSessionStore(sql, { idleMinutes: 60, maxHours: 12 });
    const token = newSessionToken();
    await store.create(token);
    await sql`update sessions set last_seen_at = now() - interval '59 minutes' where token_hash = ${sha256(token)}`;
    expect(await store.touch(token)).toBe(true);
    const [row] = await sql<{ idle: number }[]>`select extract(epoch from now() - last_seen_at)::int as idle from sessions where token_hash = ${sha256(token)}`;
    expect(row!.idle).toBeLessThan(5);
  });

  it("troca de usuário ou senha derruba as sessões abertas", async () => {
    await sql`delete from app_state`;
    const store = new PgSessionStore(sql);
    expect(await store.revokeIfCredentialsChanged("ricardo", "senha-um-bem-comprida")).toBe(0); // primeira partida
    const token = newSessionToken();
    await store.create(token);
    expect(await store.revokeIfCredentialsChanged("ricardo", "senha-um-bem-comprida")).toBe(0); // mesma senha
    expect(await store.touch(token)).toBe(true);
    expect(await store.revokeIfCredentialsChanged("ricardo", "senha-dois-bem-comprida")).toBeGreaterThanOrEqual(1);
    expect(await store.touch(token)).toBe(false);

    const state = await sql<{ value: Buffer }[]>`select value from app_state`;
    for (const row of state) expect(row.value.toString()).not.toContain("senha");
  });
});

describe("MemorySessionStore", () => {
  it("expira por inatividade e pelo tempo máximo", async () => {
    let now = 0;
    const store = new MemorySessionStore({ idleMinutes: 30, maxHours: 2 }, () => now);
    const token = newSessionToken();
    expect((await store.create(token)).getTime()).toBe(2 * 60 * 60_000);
    // Em uso a cada 29 min: continua valendo até as 2 h.
    for (now = 29 * 60_000; now < 2 * 60 * 60_000; now += 29 * 60_000) expect(await store.touch(token)).toBe(true);
    now = 2 * 60 * 60_000;
    expect(await store.touch(token)).toBe(false);

    const idle = newSessionToken();
    now = 0;
    await store.create(idle);
    now = 30 * 60_000;
    expect(await store.touch(idle)).toBe(false);
  });
});
