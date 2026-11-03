import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Sql } from "../src/db.js";
import { MigrationError, migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

describe("migrate: validação da lista", () => {
  const noDatabase = {} as Sql;

  it("recusa ids fora do padrão", async () => {
    await expect(migrate(noDatabase, [{ id: "inicial", sql: "" }])).rejects.toThrow(MigrationError);
  });

  it("recusa migrações fora de ordem", async () => {
    await expect(
      migrate(noDatabase, [
        { id: "0002_b", sql: "" },
        { id: "0001_a", sql: "" },
      ]),
    ).rejects.toThrow(/fora de ordem/);
  });

  it("as migrações do projeto estão em ordem e com ids válidos", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    for (const id of ids) expect(id).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migrate: no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("migrate");
    drop = db.drop;
    sql = connect(db.url);
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("aplica tudo num banco vazio e não repete na segunda vez", async () => {
    expect(await migrate(sql)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(sql)).toEqual([]);
    const [table] = await sql`select to_regclass('public.sessions') as name`;
    expect(table?.name).toBe("sessions");
  });

  it("não aplica nada se uma migração falha", async () => {
    const broken = [
      ...MIGRATIONS,
      { id: "9998_ok", sql: "create table should_not_exist (id int)" },
      { id: "9999_quebrada", sql: "isto não é sql" },
    ];
    await expect(migrate(sql, broken)).rejects.toThrow(/9999_quebrada falhou/);
    const [table] = await sql`select to_regclass('public.should_not_exist') as name`;
    expect(table?.name).toBeNull();
    const rows = await sql`select id from schema_migrations where id like '999%'`;
    expect(rows).toHaveLength(0);
  });

  it("recusa um banco migrado por uma versão mais nova", async () => {
    await sql`insert into schema_migrations (id) values ('9000_do_futuro')`;
    await expect(migrate(sql)).rejects.toThrow(/versão mais nova/);
    await sql`delete from schema_migrations where id = '9000_do_futuro'`;
  });

  it("duas instâncias ao mesmo tempo não aplicam a mesma migração duas vezes", async () => {
    const extra = [...MIGRATIONS, { id: "0500_paralela", sql: "create table paralela (id int)" }];
    const results = await Promise.all([migrate(sql, extra), migrate(sql, extra)]);
    expect(results.flat()).toEqual(["0500_paralela"]);
  });
});
