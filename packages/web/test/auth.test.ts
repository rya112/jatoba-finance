import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, migrate, type Sql } from "@jatoba/core";
import { Credentials, LoginLimiter, PgSessionStore, newSessionToken } from "../src/auth.js";
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
    const store = new PgSessionStore(sql);
    const valid = newSessionToken();
    const expired = newSessionToken();
    await store.create(valid, new Date(Date.now() + 60_000));
    await store.create(expired, new Date(Date.now() - 1000));

    expect(await store.isValid(valid)).toBe(true);
    expect(await store.isValid(expired)).toBe(false);
    expect(await store.isValid(newSessionToken())).toBe(false);

    const rows = await sql<{ token_hash: Buffer }[]>`select token_hash from sessions`;
    for (const row of rows) expect(row.token_hash.toString()).not.toContain(valid);

    expect(await store.purgeExpired()).toBe(1);
    await store.delete(valid);
    expect(await store.isValid(valid)).toBe(false);
  });
});
