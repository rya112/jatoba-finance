import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Sql } from "../src/db.js";
import { fingerprints } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

/**
 * Reproduz o banco real antes da 0003: o C6 exportou outubro inteiro e depois 15/10 a 03/11,
 * com FITIDs diferentes, e os lançamentos da sobreposição entraram duas vezes.
 */
describe.skipIf(!TEST_DATABASE_URL)("migração 0003: duplicados por FITID instável", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("m0003");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql, MIGRATIONS.filter((m) => m.id < "0003"));

    await sql`insert into accounts (id, kind, source, key_hash, last4, name, currency) values
      (1, 'conta', 'ofx', 'k1', '8554', 'Conta final 8554', 'BRL'),
      (2, 'cartao', 'c6-fatura', 'k2', null, 'Cartão C6', 'BRL')`;
    await sql`insert into imports (id, account_id, file_name, file_sha256, format, total, inserted, duplicates) values
      (3, 1, 'meio-out.ofx', 'a', 'ofx', 4, 4, 0),
      (4, 1, 'outubro.ofx', 'b', 'ofx', 4, 4, 0),
      (2, 2, 'fatura.csv', 'c', 'csv', 2, 2, 0)`;

    const tx = (id: number, imp: number, account: number, fp: string, date: string, amount: number, description: string) =>
      ({ id, import_id: imp, account_id: account, fingerprint: fp, external_id: fp.startsWith("fitid:") ? fp.slice(6) : null, date, amount, description, type: "DEBIT" });
    const csv = fingerprints([
      { date: "2026-10-05", amount: -1000, type: "OTHER", description: "MERCADO" },
      { date: "2026-10-05", amount: -1000, type: "OTHER", description: "MERCADO" },
    ]);
    await sql`insert into transactions ${sql([
      // Importação 3 (15/10 a 03/11): dois cafés idênticos legítimos no mesmo dia.
      tx(1, 3, 1, "fitid:GYC1", "2026-10-20", -950, "CAFE EXEMPLO"),
      tx(2, 3, 1, "fitid:GYC2", "2026-10-20", -950, "CAFE EXEMPLO"),
      tx(3, 3, 1, "fitid:GYC3", "2026-10-25", -5000, "PIX ENVIADO"),
      tx(4, 3, 1, "fitid:GYC4", "2026-11-02", -1200, "PADARIA"),
      // Importação 4 (outubro inteiro), FITIDs novos: um lançamento só dela e as cópias da sobreposição.
      tx(5, 4, 1, "fitid:GTE1", "2026-10-03", -3000, "FARMACIA"),
      tx(6, 4, 1, "fitid:GTE2", "2026-10-20", -950, "CAFE EXEMPLO"),
      tx(7, 4, 1, "fitid:GTE3", "2026-10-20", -950, "CAFE  exemplo"),
      tx(8, 4, 1, "fitid:GTE4", "2026-10-25", -5000, "PIX ENVIADO"),
      // Fatura CSV: já usava impressão por conteúdo, com duas compras iguais.
      tx(9, 2, 2, csv[0]!, "2026-10-05", -1000, "MERCADO"),
      tx(10, 2, 2, csv[1]!, "2026-10-05", -1000, "MERCADO"),
    ])}`;
    await sql`select setval('transactions_id_seq', 100)`;

    expect(await migrate(sql)).toContain("0003_content_fingerprint");
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("apaga só as cópias da sobreposição, mantendo a primeira importada", async () => {
    const ids = (await sql<{ id: string }[]>`select id from transactions order by id`).map((r) => Number(r.id));
    expect(ids).toEqual([1, 2, 3, 4, 5, 9, 10]);
  });

  it("dois cafés idênticos legítimos continuam dois", async () => {
    const [row] = await sql`select count(*)::int as n from transactions where account_id = 1 and date = '2026-10-20'`;
    expect(row!.n).toBe(2);
  });

  it("a fatura CSV não muda", async () => {
    const rows = await sql`select fingerprint from transactions where account_id = 2 order by id`;
    expect(rows.map((r) => r.fingerprint)).toEqual([
      ...fingerprints([
        { date: "2026-10-05", amount: -1000, type: "OTHER", description: "MERCADO" },
        { date: "2026-10-05", amount: -1000, type: "OTHER", description: "MERCADO" },
      ]),
    ]);
  });

  it("corrige as contagens da importação que tinha as cópias", async () => {
    const rows = await sql`select id, inserted, duplicates from imports order by id`;
    expect(rows.map((r) => [r.id, r.inserted, r.duplicates])).toEqual([
      [2, 2, 0],
      [3, 4, 0],
      [4, 1, 3],
    ]);
  });

  it("nenhum lançamento fica com impressão por FITID, e o FITID continua guardado", async () => {
    const [left] = await sql`select count(*)::int as n from transactions where fingerprint like 'fitid:%'`;
    expect(left!.n).toBe(0);
    const [kept] = await sql`select external_id from transactions where id = 1`;
    expect(kept!.external_id).toBe("GYC1");
  });

  it("as impressões novas batem com as do importador, para a próxima importação reconhecer tudo", async () => {
    const [cafe] = await sql`select fingerprint from transactions where id = 1`;
    expect(cafe!.fingerprint).toBe(fingerprints([{ date: "2026-10-20", amount: -950, type: "DEBIT", description: "CAFE EXEMPLO" }])[0]);
  });

  it("a regra de unicidade volta a valer", async () => {
    await expect(
      sql`insert into transactions (account_id, import_id, fingerprint, date, amount, description, type)
          select account_id, import_id, fingerprint, date, amount, description, type from transactions where id = 1`,
    ).rejects.toThrow(/transactions_account_fingerprint_key/);
  });
});
