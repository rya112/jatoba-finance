import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listForReview } from "../src/categories.js";
import { connect, type Sql } from "../src/db.js";
import { DuplicateError, countSuspects, listSuspects, resolveSuspect } from "../src/duplicates.js";
import { countTransactions, importFile, listTransactions } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const original = readFileSync(new URL("./fixtures/banco-exemplo-corrente.ofx", import.meta.url)).toString("latin1");

/** Nova exportação do C6: FITIDs novos e, num lançamento, o texto trocado. */
function reexport(changeText = true): Buffer {
  let text = original.replace(/<FITID>CC/g, "<FITID>NOVO");
  if (changeText) text = text.replace("PIX RECEBIDO TITULAR EXEMPLO", "TRANSFERENCIA RECEBIDA ORIGEM EXEMPLO");
  return Buffer.from(text, "latin1");
}

describe.skipIf(!TEST_DATABASE_URL)("possíveis duplicados", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("duplicates");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  beforeEach(async () => {
    await sql`truncate transactions, imports, accounts restart identity cascade`;
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("texto trocado numa nova exportação vira suspeito, não lançamento a mais escondido", async () => {
    await importFile(sql, "outubro.ofx", Buffer.from(original, "latin1"));
    const result = await importFile(sql, "outubro-de-novo.ofx", reexport());
    expect(result.statements[0]).toMatchObject({ inserted: 1, duplicates: 6, suspects: 1 });

    const [pair] = await listSuspects(sql);
    expect(pair).toMatchObject({ amount: 20000, fileName: "outubro-de-novo.ofx", original: { fileName: "outubro.ofx" } });
    expect(pair!.description).toContain("ORIGEM EXEMPLO");
    expect(pair!.original.description).toContain("TITULAR EXEMPLO");
    expect(await countSuspects(sql)).toBe(1);

    // Enquanto não decide, o suspeito não aparece na revisão de categorias.
    const review = await listForReview(sql, { limit: 100 });
    expect(review.rows.map((r) => r.id)).not.toContain(pair!.id);
  });

  it("“é o mesmo”: some das listas e contagens, e não volta ao importar de novo", async () => {
    await importFile(sql, "outubro.ofx", Buffer.from(original, "latin1"));
    await importFile(sql, "outubro-de-novo.ofx", reexport());
    const [pair] = await listSuspects(sql);
    await resolveSuspect(sql, pair!.id, "duplicado");

    expect(await countTransactions(sql)).toBe(7);
    expect((await listTransactions(sql)).map((t) => t.id)).not.toContain(pair!.id);
    expect(await listSuspects(sql)).toEqual([]);
    expect((await listForReview(sql, { limit: 100 })).rows.map((r) => r.id)).not.toContain(pair!.id);

    const again = await importFile(sql, "outubro-terceira-vez.ofx", reexport());
    expect(again.statements[0]).toMatchObject({ inserted: 0, duplicates: 7, suspects: 0 });
    expect(await countTransactions(sql)).toBe(7);
  });

  it("“são diferentes”: os dois ficam", async () => {
    await importFile(sql, "outubro.ofx", Buffer.from(original, "latin1"));
    await importFile(sql, "outubro-de-novo.ofx", reexport());
    const [pair] = await listSuspects(sql);
    await resolveSuspect(sql, pair!.id, "distinto");
    expect(await listSuspects(sql)).toEqual([]);
    expect(await countTransactions(sql)).toBe(8);
    expect((await listForReview(sql, { limit: 100 })).rows.map((r) => r.id)).toContain(pair!.id);
  });

  it("se o arquivo traz os dois textos, são dois lançamentos de verdade: sem suspeita", async () => {
    await importFile(sql, "outubro.ofx", Buffer.from(original, "latin1"));
    const both = reexport(false)
      .toString("latin1")
      .replace(
        "</BANKTRANLIST>",
        "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261020[-3:BRT]<TRNAMT>200.00<FITID>EXTRA<MEMO>OUTRA ENTRADA EXEMPLO</STMTTRN>\r\n</BANKTRANLIST>",
      );
    const result = await importFile(sql, "com-os-dois.ofx", Buffer.from(both, "latin1"));
    expect(result.statements[0]).toMatchObject({ inserted: 1, suspects: 0 });
  });

  it("valor ou data diferentes não são suspeitos", async () => {
    await importFile(sql, "outubro.ofx", Buffer.from(original, "latin1"));
    const changed = reexport().toString("latin1").replace("<TRNAMT>200.00", "<TRNAMT>200.01");
    const result = await importFile(sql, "outubro-de-novo.ofx", Buffer.from(changed, "latin1"));
    expect(result.statements[0]).toMatchObject({ inserted: 1, suspects: 0 });
  });

  it("decidir algo que não é suspeito dá erro claro", async () => {
    await importFile(sql, "outubro.ofx", Buffer.from(original, "latin1"));
    const [any] = await listTransactions(sql, { limit: 1 });
    await expect(resolveSuspect(sql, any!.id, "duplicado")).rejects.toThrow(DuplicateError);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migração 0005: pares que já existiam", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("m0005");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql, MIGRATIONS.filter((m) => m.id < "0005"));
    // Estado de antes da 0005, montado direto em SQL: a cópia com texto trocado entrou como lançamento normal.
    await sql`insert into accounts (id, kind, source, key_hash, last4, name, currency) values (1, 'conta', 'ofx', 'k', '8554', 'Conta final 8554', 'BRL')`;
    await sql`insert into imports (id, account_id, file_name, file_sha256, format, total, inserted, duplicates) values
      (3, 1, 'outubro.ofx', 'a', 'ofx', 2, 2, 0), (7, 1, 'agosto-a-novembro.ofx', 'b', 'ofx', 2, 1, 1)`;
    await sql`insert into transactions (id, account_id, import_id, fingerprint, date, amount, description, type) values
      (173, 1, 3, 'h:a#1', '2026-10-17', 8010, 'PIX RECEBIDO', 'CREDIT'),
      (174, 1, 3, 'h:b#1', '2026-10-18', -500, 'PADARIA', 'DEBIT'),
      (892, 1, 7, 'h:c#1', '2026-10-17', 8010, 'TRANSFERENCIA RECEBIDA ORIGEM', 'CREDIT')`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("marca o mais novo como suspeito do mais antigo", async () => {
    const pairs = await listSuspects(sql);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ id: "892", fileName: "agosto-a-novembro.ofx", original: { id: "173", fileName: "outubro.ofx" } });
  });
});
