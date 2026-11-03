import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isRefund, listCategories, setCategory } from "../src/categories.js";
import { connect, type Sql } from "../src/db.js";
import { billingMonth, importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const HEADER = "Data de Compra;Nome no Cartão;Final do Cartão;Categoria;Descrição;Parcela;Valor (em US$);Cotação (em R$);Valor (em R$)";
const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join("\r\n"), "utf8");

describe("billingMonth", () => {
  it("vencimento = último dia de compra + 10 dias, como nos nomes de arquivo do C6", () => {
    expect(billingMonth("2026-08-27")).toBe("2026-09-01"); // c6-202609-fatura.csv
    expect(billingMonth("2026-09-27")).toBe("2026-10-01"); // c6-202610-fatura.csv
    expect(billingMonth("2026-10-28")).toBe("2026-11-01"); // c6-202611-fatura.csv
    expect(billingMonth("2026-12-25")).toBe("2027-01-01");
    expect(billingMonth("2026-10-15")).toBe("2026-10-01");
  });
});

describe("isRefund", () => {
  it("entrada com ESTORNO no texto", () => {
    expect(isRefund({ description: "Estorno compra loja", amount: 100, accountKind: "cartao" })).toBe(true);
    expect(isRefund({ description: "ESTORNO", amount: -100, accountKind: "cartao" })).toBe(false);
    expect(isRefund({ description: "ESTORNOS DIVERSOS", amount: 100, accountKind: "cartao" })).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("mês de competência e estornos no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  const month = async (description: string) =>
    (await sql<{ m: string }[]>`select to_char(month, 'YYYY-MM') as m from transactions where description = ${description} order by id`).map((r) => r.m);
  const suggestion = async (description: string) =>
    (await sql`select c.name, t.category_source as source, t.refund_of from transactions t left join categories c on c.id = t.category_id where t.description = ${description}`)[0];

  beforeAll(async () => {
    const db = await freshDatabase("billing");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  beforeEach(async () => {
    await sql`truncate transactions, imports, accounts restart identity cascade`;
    await sql`delete from rules where origin = 'usuario'`;
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("fatura do C6: tudo entra no mês de vencimento, inclusive a parcela com data antiga", async () => {
    await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv")); // último dia de compra: 22/10
    expect(await month("MERCADO EXEMPLO")).toEqual(["2026-11"]);
    expect(await month("LOJA EXEMPLO")).toEqual(["2026-11"]); // parcela 3/10 com data de 08/07
  });

  it("conta: cada lançamento no mês da própria data", async () => {
    await importFile(sql, "conta.ofx", fixture("banco-exemplo-corrente.ofx"));
    expect(await month("CREDITO SALARIO EMPRESA EXEMPLO LTDA")).toEqual(["2026-10"]);
  });

  it("parcelas com a mesma data em faturas diferentes ficam em meses diferentes", async () => {
    await importFile(sql, "c6-202610.csv", csv("03/09/2026;T;1111;Educacional;CURSO EXEMPLO;1/12;0;0;150.00", "27/09/2026;T;1111;-;OUTRA;Única;0;0;10.00"));
    await importFile(sql, "c6-202611.csv", csv("03/09/2026;T;1111;Educacional;CURSO EXEMPLO;2/12;0;0;150.00", "28/10/2026;T;1111;-;MAIS UMA;Única;0;0;10.00"));
    expect(await month("CURSO EXEMPLO")).toEqual(["2026-10", "2026-11"]);
  });

  it("fatura exportada antes de fechar e depois: o que já existia vai para o mês da fatura fechada", async () => {
    await importFile(sql, "parcial.csv", csv("10/10/2026;T;1111;-;CAFE;Única;0;0;9.50")); // 10/10 + 10 = outubro
    expect(await month("CAFE")).toEqual(["2026-10"]);
    const full = await importFile(sql, "fechada.csv", csv("10/10/2026;T;1111;-;CAFE;Única;0;0;9.50", "28/10/2026;T;1111;-;PADARIA;Única;0;0;5.00"));
    expect(full.statements[0]).toMatchObject({ inserted: 1, duplicates: 1 });
    expect(await month("CAFE")).toEqual(["2026-11"]);
    expect(await month("PADARIA")).toEqual(["2026-11"]);
  });

  it("estorno no mesmo arquivo herda a categoria da compra (como a anuidade do C6)", async () => {
    await importFile(
      sql,
      "fatura.csv",
      csv("24/10/2026;T;1111;Departamento / Desconto;LOJA EXEMPLO;10/12;0;0;98.00", "24/10/2026;T;1111;-;ESTORNO LOJA EXEMPLO;Única;0;0;-98.00"),
    );
    const refund = await suggestion("ESTORNO LOJA EXEMPLO");
    expect(refund).toMatchObject({ name: "Compras", source: "estorno" });
    const [purchase] = await sql`select id from transactions where description = 'LOJA EXEMPLO'`;
    expect(refund!.refund_of).toBe(purchase!.id);
  });

  it("estorno em arquivo posterior também acha a compra", async () => {
    await importFile(sql, "out.csv", csv("05/10/2026;T;1111;Vestuário / Roupas;ROUPA EXEMPLO;Única;0;0;120.00"));
    await importFile(sql, "nov.csv", csv("02/11/2026;T;1111;-;ESTORNO ROUPA;Única;0;0;-120.00"));
    expect(await suggestion("ESTORNO ROUPA")).toMatchObject({ name: "Vestuário", source: "estorno" });
  });

  it("não casa com valor diferente, fora de 60 dias, nem com pagamento de fatura", async () => {
    await importFile(
      sql,
      "fatura.csv",
      csv(
        "01/07/2026;T;1111;Vestuário / Roupas;ANTIGA;Única;0;0;50.00",
        "20/10/2026;T;1111;Vestuário / Roupas;OUTRO VALOR;Única;0;0;51.00",
        "22/10/2026;T;1111;-;ESTORNO X;Única;0;0;-50.00",
      ),
    );
    expect(await suggestion("ESTORNO X")).toMatchObject({ name: null, source: null });
  });

  it("regra do usuário vence o casamento de estorno", async () => {
    await importFile(sql, "fatura.csv", csv("24/10/2026;T;1111;Departamento / Desconto;LOJA EXEMPLO;Única;0;0;98.00", "24/10/2026;T;1111;-;ESTORNO LOJA EXEMPLO;Única;0;0;-98.00"));
    const reembolsos = (await listCategories(sql)).find((c) => c.name === "Reembolsos")!.id;
    const [refund] = await sql<{ id: string }[]>`select id from transactions where description = 'ESTORNO LOJA EXEMPLO'`;
    await setCategory(sql, refund!.id, reembolsos, { rulePattern: "ESTORNO LOJA" });
    expect(await suggestion("ESTORNO LOJA EXEMPLO")).toMatchObject({ name: "Reembolsos", source: "manual" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migração 0006 nos dados que já existiam", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("m0006");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql, MIGRATIONS.filter((m) => m.id < "0006"));
    await sql`insert into accounts (id, kind, source, key_hash, last4, name, currency) values
      (1, 'conta', 'ofx', 'k1', '8554', 'Conta final 8554', 'BRL'), (2, 'cartao', 'c6-fatura', 'k2', null, 'Cartão C6', 'BRL')`;
    await sql`insert into imports (id, account_id, file_name, file_sha256, format, first_date, last_date, total, inserted, duplicates) values
      (1, 1, 'conta.ofx', 'a', 'ofx', '2026-10-01', '2026-10-31', 1, 1, 0),
      (2, 2, 'c6-202610-fatura.csv', 'b', 'csv', '2026-08-28', '2026-09-27', 1, 1, 0),
      (3, 2, 'c6-202611-fatura.csv', 'c', 'csv', '2026-09-03', '2026-10-28', 1, 1, 0)`;
    await sql`insert into transactions (id, account_id, import_id, fingerprint, date, amount, description, type) values
      (1, 1, 1, 'h:1#1', '2026-10-17', 8010, 'PIX', 'CREDIT'),
      (2, 2, 2, 'h:2#1', '2026-09-03', -15000, 'CURSO 1/12', 'OTHER'),
      (3, 2, 3, 'h:3#1', '2026-09-03', -15000, 'CURSO 2/12', 'OTHER')`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("conta pelo mês da data; cartão do C6 pelo vencimento da fatura de origem", async () => {
    const rows = await sql`select id, to_char(month, 'YYYY-MM') as m from transactions order by id`;
    expect(rows.map((r) => [r.id, r.m])).toEqual([
      ["1", "2026-10"],
      ["2", "2026-10"],
      ["3", "2026-11"],
    ]);
  });
});
