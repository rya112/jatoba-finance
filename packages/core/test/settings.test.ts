import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveSuggestions, categorize, listCategories, setCategory } from "../src/categories.js";
import { connect, type Sql } from "../src/db.js";
import { importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import {
  createCategory,
  createRule,
  deleteCategory,
  deleteRule,
  listAccounts,
  listCategoryUsage,
  listRuleDetails,
  renameAccount,
  updateCategory,
  updateRule,
} from "../src/settings.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe.skipIf(!TEST_DATABASE_URL)("ajustes", () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  const catId = async (name: string) => (await listCategories(sql)).find((c) => c.name === name)?.id;
  const categoryOf = async (description: string) =>
    (await sql<{ name: string | null; source: string | null; reviewed: boolean }[]>`
      select c.name, t.category_source as source, t.reviewed from transactions t left join categories c on c.id = t.category_id
      where t.description = ${description} order by t.id limit 1`)[0]!;
  const id = async (description: string) => (await sql<{ id: string }[]>`select id from transactions where description = ${description} order by id limit 1`)[0]!.id;

  beforeAll(async () => {
    const db = await freshDatabase("settings");
    drop = db.drop;
    sql = connect(db.url);
  });

  beforeEach(async () => {
    // Banco novo a cada teste: categorias e regras voltam ao padrão.
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await migrate(sql);
    await importFile(sql, "conta.ofx", fixture("banco-exemplo-corrente.ofx"));
    await importFile(sql, "fatura.csv", fixture("c6-fatura-exemplo.csv"));
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  describe("categorias", () => {
    it("lista com quantos lançamentos e regras cada uma tem", async () => {
      const usage = await listCategoryUsage(sql);
      expect(usage).toHaveLength(25);
      const fatura = usage.find((c) => c.name === "Pagamento de fatura")!;
      expect(fatura.rules).toBe(2);
      expect(fatura.transactions).toBeGreaterThanOrEqual(2);
    });

    it("cria no fim do grupo e recusa nome repetido ou vazio", async () => {
      const novo = await createCategory(sql, { name: "  Seguros  ", kind: "despesa" });
      const usage = await listCategoryUsage(sql);
      const despesas = usage.filter((c) => c.kind === "despesa");
      expect(despesas.at(-1)).toMatchObject({ id: novo, name: "Seguros" });
      await expect(createCategory(sql, { name: "seguros", kind: "despesa" })).rejects.toThrow(/Já existe/);
      await expect(createCategory(sql, { name: " ", kind: "despesa" })).rejects.toThrow(/2 a 40/);
      await expect(createCategory(sql, { name: "Xyz", kind: "outro" })).rejects.toThrow(/Tipo/);
    });

    it("renomear mantém as sugestões vindas da categoria do C6", async () => {
      await updateCategory(sql, (await catId("Mercado"))!, { name: "Supermercado", kind: "despesa" });
      await categorize(sql);
      expect(await categoryOf("MERCADO EXEMPLO")).toMatchObject({ name: "Supermercado", source: "banco" });
    });

    it("mudar o tipo leva a categoria para o outro grupo", async () => {
      const outros = (await catId("Outros"))!;
      await updateCategory(sql, outros, { name: "Outros", kind: "movimentacao" });
      const usage = await listCategoryUsage(sql);
      expect(usage.filter((c) => c.kind === "movimentacao").at(-1)!.id).toBe(outros);
    });

    it("apagar movendo: lançamentos, revisão e regras vão para a outra; sugestões do C6 também", async () => {
      const mercado = (await catId("Mercado"))!;
      const compras = (await catId("Compras"))!;
      await approveSuggestions(sql, [await id("MERCADO EXEMPLO")]);
      await createRule(sql, { pattern: "padaria", direction: "", accountKind: "", categoryId: mercado });

      const moved = await deleteCategory(sql, mercado, { moveTo: compras });
      expect(moved).toBeGreaterThanOrEqual(1);
      expect(await catId("Mercado")).toBeUndefined();
      expect(await categoryOf("MERCADO EXEMPLO")).toMatchObject({ name: "Compras", reviewed: true });
      expect((await listRuleDetails(sql)).find((r) => r.pattern === "PADARIA")!.categoryName).toBe("Compras");

      // Uma fatura nova: “Supermercados...” do C6 agora vai para Compras.
      await importFile(sql, "outra.csv", Buffer.from(
        "Data de Compra;Nome no Cartão;Final do Cartão;Categoria;Descrição;Parcela;Valor (em US$);Cotação (em R$);Valor (em R$)\r\n" +
          "05/11/2026;T;1111;Supermercados / Mercearia / Padarias / Lojas de Conveniência;OUTRO MERCADO;Única;0;0;50.00",
      ));
      expect(await categoryOf("OUTRO MERCADO")).toMatchObject({ name: "Compras", source: "banco" });
    });

    it("apagar sem mover: lançamentos voltam para a revisão, sem categoria", async () => {
      const mercado = (await catId("Mercado"))!;
      await setCategory(sql, await id("MERCADO EXEMPLO"), mercado);
      await deleteCategory(sql, mercado);
      expect(await categoryOf("MERCADO EXEMPLO")).toMatchObject({ name: null, reviewed: false });
    });

    it("recusa mover para ela mesma ou para categoria inexistente", async () => {
      const mercado = (await catId("Mercado"))!;
      await expect(deleteCategory(sql, mercado, { moveTo: mercado })).rejects.toThrow(/outra categoria/);
      await expect(deleteCategory(sql, mercado, { moveTo: 99999 })).rejects.toThrow(/não existe/);
      expect(await catId("Mercado")).toBe(mercado);
    });
  });

  describe("regras", () => {
    it("lista as do usuário primeiro, com quantos lançamentos cada uma classifica", async () => {
      await createRule(sql, { pattern: "Energia exemplo", direction: "saida", accountKind: "conta", categoryId: (await catId("Contas da casa"))! });
      const rules = await listRuleDetails(sql);
      expect(rules[0]).toMatchObject({ pattern: "ENERGIA EXEMPLO", origin: "usuario", categoryName: "Contas da casa", matches: 1, direction: "saida", accountKind: "conta" });
      expect(rules.find((r) => r.pattern === "FATURA")).toMatchObject({ origin: "sistema", matches: 1 });
    });

    it("criar aplica na hora; editar muda a sugestão; apagar tira", async () => {
      const casa = (await catId("Contas da casa"))!;
      const outros = (await catId("Outros"))!;
      expect(await createRule(sql, { pattern: "ENERGIA", direction: "", accountKind: "", categoryId: casa })).toBe(1);
      expect(await categoryOf("DEB AUTOMATICO ENERGIA EXEMPLO")).toMatchObject({ name: "Contas da casa", source: "regra" });

      const rule = (await listRuleDetails(sql)).find((r) => r.pattern === "ENERGIA")!;
      await updateRule(sql, rule.id, { pattern: "ENERGIA", direction: "saida", accountKind: "conta", categoryId: outros });
      expect(await categoryOf("DEB AUTOMATICO ENERGIA EXEMPLO")).toMatchObject({ name: "Outros" });

      await deleteRule(sql, rule.id);
      expect(await categoryOf("DEB AUTOMATICO ENERGIA EXEMPLO")).toMatchObject({ name: null, source: null });
    });

    it("nunca muda o que foi escolhido à mão ou revisado", async () => {
      const casa = (await catId("Contas da casa"))!;
      const lazer = (await catId("Lazer"))!;
      await setCategory(sql, await id("DEB AUTOMATICO ENERGIA EXEMPLO"), lazer);
      await createRule(sql, { pattern: "ENERGIA", direction: "", accountKind: "", categoryId: casa });
      expect(await categoryOf("DEB AUTOMATICO ENERGIA EXEMPLO")).toMatchObject({ name: "Lazer", source: "manual" });

      await approveSuggestions(sql, [await id("PAGAMENTO FATURA CARTAO EXEMPLO")]);
      const fatura = (await listRuleDetails(sql)).find((r) => r.pattern === "FATURA")!;
      await deleteRule(sql, fatura.id);
      expect(await categoryOf("PAGAMENTO FATURA CARTAO EXEMPLO")).toMatchObject({ name: "Pagamento de fatura", reviewed: true });
    });

    it("editar uma regra do sistema a torna do usuário", async () => {
      const fatura = (await listRuleDetails(sql)).find((r) => r.pattern === "FATURA")!;
      await updateRule(sql, fatura.id, { pattern: "FATURA", direction: "saida", accountKind: "conta", categoryId: fatura.categoryId });
      expect((await listRuleDetails(sql)).find((r) => r.id === fatura.id)!.origin).toBe("usuario");
    });

    it("recusa texto curto, filtro inválido, categoria inexistente e regra repetida", async () => {
      const casa = (await catId("Contas da casa"))!;
      await expect(createRule(sql, { pattern: "ab", direction: "", accountKind: "", categoryId: casa })).rejects.toThrow(/3 letras/);
      await expect(createRule(sql, { pattern: "abc", direction: "lado", accountKind: "", categoryId: casa })).rejects.toThrow(/Filtro/);
      await expect(createRule(sql, { pattern: "abc", direction: "", accountKind: "", categoryId: 99999 })).rejects.toThrow(/Categoria não encontrada/);
      await createRule(sql, { pattern: "ENERGIA", direction: "", accountKind: "", categoryId: casa });
      const other = (await listRuleDetails(sql)).find((r) => r.pattern === "IOF")!;
      await expect(updateRule(sql, other.id, { pattern: "energia", direction: "", accountKind: "", categoryId: casa })).rejects.toThrow(/Já existe outra regra/);
    });
  });

  describe("contas", () => {
    it("lista e renomeia", async () => {
      const [conta] = (await listAccounts(sql)).filter((a) => a.kind === "conta");
      expect(conta).toMatchObject({ name: "Conta final 0000", transactions: 7, currency: "BRL" });
      await renameAccount(sql, conta!.id, "  C6 conta corrente ");
      expect((await listAccounts(sql)).find((a) => a.id === conta!.id)!.name).toBe("C6 conta corrente");
      await expect(renameAccount(sql, conta!.id, "x")).rejects.toThrow(/2 a 40/);
      await expect(renameAccount(sql, 99999, "Nome")).rejects.toThrow(/não encontrada/);
    });
  });
});
