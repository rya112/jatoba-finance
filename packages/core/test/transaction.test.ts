import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveSuggestions, listCategories, listForReview, setCategory } from "../src/categories.js";
import { connect, type Sql } from "../src/db.js";
import { importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { getTransaction, reopenReview } from "../src/transaction.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe.skipIf(!TEST_DATABASE_URL)("um lançamento", () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  const idOf = async (description: string) => (await sql<{ id: string }[]>`select id from transactions where description = ${description} order by id limit 1`)[0]!.id;
  const cat = async (name: string) => (await listCategories(sql)).find((c) => c.name === name)!.id;

  beforeAll(async () => {
    const db = await freshDatabase("transaction");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  beforeEach(async () => {
    await sql`truncate goal_entries, goals, transactions, imports, accounts restart identity cascade`;
    await sql`delete from rules where origin = 'usuario'`;
    await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv"));
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("traz todos os detalhes", async () => {
    const t = await getTransaction(sql, await idOf("STREAMING EXEMPLO"));
    expect(t).toMatchObject({
      date: "2026-10-14",
      month: "2026-11-01",
      amount: -4490,
      accountName: "Cartão C6",
      billing: true,
      cardLast4: "3333",
      bankCategory: "TV por assinatura / Serviços de rádio",
      foreign: { amount: -799, currency: "USD", rate: "5.62" },
      categoryName: "Assinaturas",
      categorySource: "banco",
      reviewed: false,
      fileName: "fatura.csv",
      duplicateOf: null,
    });
    expect((await getTransaction(sql, await idOf("LOJA EXEMPLO")))!.installment).toBe("3/10");
  });

  it("id inválido ou inexistente", async () => {
    expect(await getTransaction(sql, "abc")).toBeUndefined();
    expect(await getTransaction(sql, "99999")).toBeUndefined();
  });

  it("dá para trocar a categoria de um lançamento já revisado", async () => {
    const id = await idOf("MERCADO EXEMPLO");
    await approveSuggestions(sql, [id]);
    expect(await getTransaction(sql, id)).toMatchObject({ categoryName: "Mercado", reviewed: true });
    await setCategory(sql, id, await cat("Outros"));
    expect(await getTransaction(sql, id)).toMatchObject({ categoryName: "Outros", categorySource: "manual", reviewed: true });
  });

  it("voltar para revisão: desfaz a escolha e restaura a sugestão automática", async () => {
    const id = await idOf("MERCADO EXEMPLO");
    await setCategory(sql, id, await cat("Lazer"));
    expect((await listForReview(sql, { limit: 100 })).rows.map((r) => r.id)).not.toContain(id);

    await reopenReview(sql, id);
    expect(await getTransaction(sql, id)).toMatchObject({ categoryName: "Mercado", categorySource: "banco", reviewed: false });
    expect((await listForReview(sql, { limit: 100 })).rows.map((r) => r.id)).toContain(id);
  });

  it("voltar para revisão sem sugestão possível deixa sem categoria", async () => {
    const id = await idOf("HOTEL EXEMPLO; CENTRO");
    await sql`update transactions set bank_category = null where id = ${id}`;
    await setCategory(sql, id, await cat("Viagens"));
    await reopenReview(sql, id);
    expect(await getTransaction(sql, id)).toMatchObject({ categoryName: null, reviewed: false });
  });
});
