import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Sql } from "../src/db.js";
import { ImportError, countTransactions, fingerprints, importFile, listTransactions, readStatementFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("fingerprints", () => {
  it("ignora o FITID: o mesmo lançamento com FITIDs diferentes (como no C6) tem a mesma impressão", () => {
    const t = { date: "2026-10-01", amount: -100, type: "DEBIT", description: "X" };
    expect(fingerprints([{ ...t, externalId: "99M9GYC9XQ" }])).toEqual(fingerprints([{ ...t, externalId: "99M9GTE9F9" }]));
  });

  it("sem FITID, compras idênticas no mesmo arquivo recebem números de ocorrência diferentes", () => {
    const cafe = { date: "2026-10-22", amount: -950, type: "OTHER", description: "CAFE EXEMPLO" };
    const [a, b] = fingerprints([cafe, { ...cafe }]);
    expect(a).toMatch(/#1$/);
    expect(b).toMatch(/#2$/);
    expect(a!.replace(/#\d$/, "")).toBe(b!.replace(/#\d$/, ""));
  });

  it("ignora diferença de maiúsculas e espaços na descrição, mas não de parcela", () => {
    const t = { date: "2026-10-01", amount: -100, type: "OTHER", description: "Loja  Exemplo" };
    expect(fingerprints([t])).toEqual(fingerprints([{ ...t, description: "LOJA EXEMPLO" }]));
    expect(fingerprints([{ ...t, installment: { current: 1, total: 3 } }])).not.toEqual(fingerprints([{ ...t, installment: { current: 2, total: 3 } }]));
  });
});

describe("readStatementFile", () => {
  it("reconhece OFX e o CSV do C6", () => {
    expect(readStatementFile(fixture("cartao-exemplo.ofx")).source).toBe("ofx");
    expect(readStatementFile(fixture("c6-fatura-exemplo.csv")).source).toBe("c6-fatura");
  });

  it("recusa formatos desconhecidos e arquivos vazios com mensagem clara", () => {
    expect(() => readStatementFile(Buffer.from("Data,Valor\n1,2"))).toThrow(/Formato não reconhecido/);
    expect(() => readStatementFile(Buffer.from(""))).toThrow(/vazio/);
    expect(() => readStatementFile(Buffer.alloc(11 * 1024 * 1024, 32))).toThrow(ImportError);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("importFile no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("importer");
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

  it("importa um OFX e, importado de novo, não duplica nada e avisa", async () => {
    const first = await importFile(sql, "cartao.ofx", fixture("cartao-exemplo.ofx"));
    expect(first.previouslyImportedAt).toBeUndefined();
    expect(first.statements[0]).toMatchObject({ total: 8, inserted: 8, duplicates: 0, accountName: "Cartão final 0000" });

    const again = await importFile(sql, "cartao (1).ofx", fixture("cartao-exemplo.ofx"));
    expect(again.previouslyImportedAt).toBeInstanceOf(Date);
    expect(again.statements[0]).toMatchObject({ inserted: 0, duplicates: 8, accountId: first.statements[0]!.accountId });
    expect(await countTransactions(sql)).toBe(8);
  });

  it("período sobreposto: só os lançamentos novos entram", async () => {
    await importFile(sql, "parte1.ofx", fixture("cartao-exemplo.ofx"));
    const text = fixture("cartao-exemplo.ofx").toString("latin1");
    const extended = text.replace(
      "</BANKTRANLIST>",
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105[-3:BRT]<TRNAMT>-12.00<FITID>CT20261105001<MEMO>PADARIA EXEMPLO</STMTTRN>\r\n</BANKTRANLIST>",
    );
    const result = await importFile(sql, "parte2.ofx", Buffer.from(extended, "latin1"));
    expect(result.previouslyImportedAt).toBeUndefined();
    expect(result.statements[0]).toMatchObject({ total: 9, inserted: 1, duplicates: 8 });
  });

  it("CSV sem FITID: reimportar não duplica, e os dois cafés iguais continuam dois", async () => {
    const first = await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv"));
    expect(first.statements[0]).toMatchObject({ total: 9, inserted: 9, accountName: "Cartão C6" });
    expect(first.warnings).toEqual(["linha 11: data inválida; ignorada."]);
    const again = await importFile(sql, "fatura-de-novo.csv", fixture("c6-fatura-exemplo.csv"));
    expect(again.statements[0]).toMatchObject({ inserted: 0, duplicates: 9 });

    const cafes = await sql`select count(*)::int as n from transactions where description = 'CAFE EXEMPLO'`;
    expect(cafes[0]!.n).toBe(2);
  });

  it("guarda parcela, cartão, categoria e valor estrangeiro, e só os 4 últimos dígitos da conta", async () => {
    await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv"));
    await importFile(sql, "conta.ofx", fixture("ofx2-xml-utf8.ofx"));
    const [loja] = await sql`select * from transactions where description = 'LOJA EXEMPLO'`;
    expect(loja).toMatchObject({ installment_current: 3, installment_total: 10, card_last4: "1111", bank_category: "Departamento / Desconto", amount: "-19990" });
    const [streaming] = await sql`select foreign_amount, foreign_currency, foreign_rate from transactions where description = 'STREAMING EXEMPLO'`;
    expect(streaming).toEqual({ foreign_amount: "-799", foreign_currency: "USD", foreign_rate: "5.62" });

    const accounts = await sql`select * from accounts order by id`;
    expect(accounts.map((a) => a.last4)).toEqual([null, "3456"]);
    expect(JSON.stringify(accounts)).not.toContain("12345-6");
  });

  it("OFX com FITIDs novos a cada exportação (C6): a sobreposição não duplica", async () => {
    await importFile(sql, "outubro.ofx", fixture("banco-exemplo-corrente.ofx"));
    const reexported = fixture("banco-exemplo-corrente.ofx").toString("latin1").replace(/<FITID>CC/g, "<FITID>NOVO");
    const result = await importFile(sql, "outubro-de-novo.ofx", Buffer.from(reexported, "latin1"));
    expect(result.previouslyImportedAt).toBeUndefined();
    expect(result.statements[0]).toMatchObject({ inserted: 0, duplicates: 7 });
  });

  it("conta e cartão no mesmo OFX viram duas contas", async () => {
    const result = await importFile(sql, "dois.ofx", fixture("sgml-1252-conta-e-cartao.ofx"));
    expect(result.statements.map((s) => s.accountName)).toEqual(["Conta final 9999", "Cartão final 0000"]);
    expect(result.statements.map((s) => s.inserted)).toEqual([2, 1]);
  });

  it("lista os lançamentos mais recentes primeiro", async () => {
    await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv"));
    const rows = await listTransactions(sql, { limit: 3 });
    expect(rows[0]).toMatchObject({ date: "2026-10-22", accountName: "Cartão C6", currency: "BRL" });
    expect(rows).toHaveLength(3);
    const loja = (await listTransactions(sql)).find((r) => r.description === "LOJA EXEMPLO");
    expect(loja).toMatchObject({ installment: "3/10", cardLast4: "1111", amount: -19990 });
  });

  it("se algo falha no meio, nada da importação fica gravado", async () => {
    await sql`alter table transactions add constraint teste_falha check (description <> 'POSTO EXEMPLO')`;
    try {
      await expect(importFile(sql, "cartao.ofx", fixture("cartao-exemplo.ofx"))).rejects.toThrow();
      expect(await countTransactions(sql)).toBe(0);
      const [imports] = await sql`select count(*)::int as n from imports`;
      expect(imports!.n).toBe(0);
    } finally {
      await sql`alter table transactions drop constraint teste_falha`;
    }
  });
});
