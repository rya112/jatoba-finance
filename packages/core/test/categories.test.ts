import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BANK_CATEGORY_MAP,
  approveSuggestions,
  categorize,
  cleanDescription,
  listCategories,
  listForReview,
  normalizeText,
  ruleMatches,
  setCategory,
  sortRules,
  suggestCategory,
  type Rule,
} from "../src/categories.js";
import { connect, type Sql } from "../src/db.js";
import { importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("normalizeText", () => {
  it("maiúsculo, sem acento, espaços simples", () => {
    expect(normalizeText("  Farmácia   São João ")).toBe("FARMACIA SAO JOAO");
  });
});

describe("cleanDescription", () => {
  it.each([
    ["PIX ENVIADO TITULAR EXEMPLO", "TITULAR EXEMPLO"],
    ["PIX RECEBIDO - TITULAR EXEMPLO", "TITULAR EXEMPLO"],
    ["Pix enviado para Fulano Exemplo", "Fulano Exemplo"],
    ["COMPRA CARTAO DEBITO SUPERMERCADO EXEMPLO SAO PAULO", "SUPERMERCADO EXEMPLO SAO PAULO"],
    ["COMPRA NO DÉBITO - PADARIA EXEMPLO", "PADARIA EXEMPLO"],
    ["DEB AUTOMATICO ENERGIA EXEMPLO", "ENERGIA EXEMPLO"],
    ["PAGAMENTO DE BOLETO ESCOLA EXEMPLO", "ESCOLA EXEMPLO"],
    ["UBER *TRIP   ", "UBER *TRIP"],
    ["LOJA EXEMPLO -", "LOJA EXEMPLO"],
  ])("%s → %s", (raw, clean) => {
    expect(cleanDescription(raw)).toBe(clean);
  });

  it("nunca devolve vazio", () => {
    expect(cleanDescription("PIX ENVIADO")).toBe("PIX ENVIADO");
  });
});

describe("regras", () => {
  const rule = (over: Partial<Rule>): Rule => ({ id: 1, pattern: "X", direction: null, accountKind: null, categoryId: 1, origin: "sistema", ...over });

  it("filtra por direção e tipo de conta", () => {
    const fatura = rule({ pattern: "FATURA", direction: "saida", accountKind: "conta" });
    expect(ruleMatches(fatura, { description: "Pagamento fatura", amount: -100, accountKind: "conta" })).toBe(true);
    expect(ruleMatches(fatura, { description: "Pagamento fatura", amount: 100, accountKind: "conta" })).toBe(false);
    expect(ruleMatches(fatura, { description: "Pagamento fatura", amount: -100, accountKind: "cartao" })).toBe(false);
  });

  it("compara sem acento e sem diferença de maiúsculas", () => {
    expect(ruleMatches(rule({ pattern: "FARMACIA" }), { description: "farmácia exemplo", amount: -1, accountKind: "conta" })).toBe(true);
  });

  it("regra do usuário vence a do sistema; depois, a mais específica", () => {
    const sorted = sortRules([
      rule({ id: 1, pattern: "PIX", origin: "sistema" }),
      rule({ id: 2, pattern: "PIX ENVIADO MAE", origin: "sistema" }),
      rule({ id: 3, pattern: "PIX", origin: "usuario" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("sem regra, usa a categoria do banco mapeada; sem mapeamento, não sugere", () => {
    const byName = new Map([["Mercado", 3]]);
    const input = { description: "LOJA", amount: -1, accountKind: "cartao" as const };
    expect(suggestCategory({ ...input, bankCategory: "Supermercados / Mercearia / Padarias / Lojas de Conveniência" }, [], byName)).toEqual({ categoryId: 3, source: "banco" });
    expect(suggestCategory({ ...input, bankCategory: "Seguro" }, [], byName)).toBeUndefined();
  });

  it("o mapa do C6 cobre as categorias vistas na fatura real e aponta para categorias que existem", async () => {
    const names = ["Mercado", "Transporte", "Saúde", "Assinaturas", "Restaurantes e delivery", "Vestuário", "Compras", "Cuidados pessoais", "Lazer", "Educação"];
    for (const target of Object.values(BANK_CATEGORY_MAP)) expect(names).toContain(target);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("categorias no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  const categoryOf = async (description: string) => {
    const [row] = await sql<{ name: string | null; source: string | null; clean: string | null }[]>`
      select c.name, t.category_source as source, t.clean_description as clean
      from transactions t left join categories c on c.id = t.category_id where t.description = ${description}
    `;
    return row;
  };
  const idOf = async (description: string) => (await sql<{ id: string }[]>`select id from transactions where description = ${description}`)[0]!.id;
  const categoryId = async (name: string) => (await listCategories(sql)).find((c) => c.name === name)!.id;

  beforeAll(async () => {
    const db = await freshDatabase("categories");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  beforeEach(async () => {
    await sql`truncate transactions, imports, accounts restart identity cascade`;
    await sql`delete from rules where origin = 'usuario'`;
    await importFile(sql, "conta.ofx", fixture("banco-exemplo-corrente.ofx"));
    await importFile(sql, "cartao.ofx", fixture("cartao-exemplo.ofx"));
    await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv"));
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("a lista de categorias combinada existe, nos três grupos", async () => {
    const categories = await listCategories(sql);
    expect(categories).toHaveLength(25);
    expect(categories.filter((c) => c.kind === "movimentacao").map((c) => c.name)).toEqual([
      "Transferência entre contas",
      "Pagamento de fatura",
      "Aporte em investimento",
      "Resgate de investimento",
    ]);
  });

  it("a importação já sugere pelas regras do sistema", async () => {
    expect(await categoryOf("PAGAMENTO FATURA CARTAO EXEMPLO")).toMatchObject({ name: "Pagamento de fatura", source: "regra" });
    expect(await categoryOf("PAGAMENTO RECEBIDO")).toMatchObject({ name: "Pagamento de fatura" });
    expect(await categoryOf("APLICACAO CDB EXEMPLO")).toMatchObject({ name: "Aporte em investimento" });
    expect(await categoryOf("CREDITO SALARIO EMPRESA EXEMPLO LTDA")).toMatchObject({ name: "Salário" });
  });

  it("e pela categoria do C6 na fatura", async () => {
    expect(await categoryOf("MERCADO EXEMPLO")).toMatchObject({ name: "Mercado", source: "banco" });
    expect(await categoryOf("HOTEL EXEMPLO; CENTRO")).toMatchObject({ name: "Lazer", source: "banco" });
  });

  it("grava a descrição limpa, sem perder a original", async () => {
    expect(await categoryOf("COMPRA CARTAO DEBITO SUPERMERCADO EXEMPLO SAO PAULO")).toMatchObject({ clean: "SUPERMERCADO EXEMPLO SAO PAULO", name: null });
  });

  it("escolha manual com regra: vale para os parecidos, e nunca é sobrescrita", async () => {
    const lazer = await categoryId("Lazer");
    const assinaturas = await categoryId("Assinaturas");
    const ids = (await sql<{ id: string }[]>`select id from transactions where description = 'STREAMING EXEMPLO' order by id`).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(3); // dois no OFX do cartão e um na fatura CSV

    const result = await setCategory(sql, ids[0]!, assinaturas, { rulePattern: "streaming exemplo" });
    expect(result.ruleCreated).toBe(true);
    // O segundo do OFX ganha a categoria; o da fatura já tinha Assinaturas pela categoria do C6.
    expect(result.otherChanged).toBe(1);
    for (const id of ids) {
      const [row] = await sql`select category_id, category_source from transactions where id = ${id}`;
      expect(row!.category_id).toBe(assinaturas);
    }

    // Outra escolha manual, sem regra, no segundo: continua manual mesmo depois de recategorizar.
    await setCategory(sql, ids[1]!, lazer);
    await categorize(sql);
    const [second] = await sql`select category_id, category_source, reviewed from transactions where id = ${ids[1]!}`;
    expect(second).toMatchObject({ category_id: lazer, category_source: "manual", reviewed: true });
  });

  it("regra do usuário vence a categoria do banco", async () => {
    const cafes = (await sql<{ id: string }[]>`select id from transactions where description = 'CAFE EXEMPLO' order by id`).map((r) => r.id);
    expect(await categoryOf("CAFE EXEMPLO")).toMatchObject({ name: "Restaurantes e delivery", source: "banco" });
    await setCategory(sql, cafes[0]!, await categoryId("Outros"), { rulePattern: "CAFE EXEMPLO" });
    const [second] = await sql`select c.name, t.category_source from transactions t join categories c on c.id = t.category_id where t.id = ${cafes[1]!}`;
    expect(second).toEqual({ name: "Outros", category_source: "regra" });
  });

  it("regra do usuário vence a regra do sistema", async () => {
    // "PAGAMENTO RECEBIDO" no cartão: o sistema sugere Pagamento de fatura.
    const rows = (await sql<{ id: string }[]>`select id from transactions where description = 'PAGAMENTO RECEBIDO' order by id`).map((r) => r.id);
    expect(rows).toHaveLength(2); // um no OFX do cartão, outro na fatura CSV
    await setCategory(sql, rows[0]!, await categoryId("Reembolsos"), { rulePattern: "PAGAMENTO RECEBIDO" });
    const [other] = await sql`select c.name from transactions t join categories c on c.id = t.category_id where t.id = ${rows[1]!}`;
    expect(other!.name).toBe("Reembolsos");
  });

  it("recusa regra curta demais e categoria inexistente", async () => {
    const id = await idOf("POSTO EXEMPLO");
    await expect(setCategory(sql, id, await categoryId("Transporte"), { rulePattern: "ab" })).rejects.toThrow(/3 letras/);
    await expect(setCategory(sql, id, 99999)).rejects.toThrow(/Categoria não encontrada/);
  });

  it("revisão: sem sugestão primeiro; aprovar marca só os que têm sugestão", async () => {
    const before = await listForReview(sql, { limit: 100 });
    expect(before.total).toBe(before.rows.length);
    const firstWithSuggestion = before.rows.findIndex((r) => r.categoryId !== null);
    expect(before.rows.slice(firstWithSuggestion).every((r) => r.categoryId !== null)).toBe(true);
    expect(before.rows.slice(0, firstWithSuggestion).every((r) => r.categoryId === null)).toBe(true);

    const approved = await approveSuggestions(sql, before.rows.map((r) => r.id));
    expect(approved).toBe(before.withSuggestion);
    const after = await listForReview(sql, { limit: 100 });
    expect(after.total).toBe(before.total - before.withSuggestion);
    expect(after.withSuggestion).toBe(0);
  });

  it("lançamentos revisados não mudam quando surge uma regra nova", async () => {
    const mercado = await idOf("MERCADO EXEMPLO");
    await approveSuggestions(sql, [mercado]);
    await setCategory(sql, await idOf("LOJA EXEMPLO"), await categoryId("Outros"), { rulePattern: "EXEMPLO" });
    expect(await categoryOf("MERCADO EXEMPLO")).toMatchObject({ name: "Mercado" });
  });
});
