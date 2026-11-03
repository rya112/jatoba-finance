import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Sql } from "../src/db.js";
import { countTransactions, listTransactions } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { addMonths, listMonths, monthSummary, parseMonth } from "../src/month.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

describe("addMonths e parseMonth", () => {
  it("navegam entre meses, inclusive na virada de ano", () => {
    expect(addMonths("2026-11-01", -1)).toBe("2026-10-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(parseMonth("2026-11")).toBe("2026-11-01");
    expect(parseMonth("2026-13")).toBeUndefined();
    expect(parseMonth(undefined)).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("resumo do mês", () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  const cat = async (name: string) => (await sql<{ id: number }[]>`select id from categories where name = ${name}`)[0]!.id;

  beforeAll(async () => {
    const db = await freshDatabase("month");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
    await sql`insert into accounts (id, kind, source, key_hash, last4, name, currency) values
      (1, 'conta', 'ofx', 'k1', '8554', 'Conta', 'BRL'),
      (2, 'cartao', 'c6-fatura', 'k2', null, 'Cartão C6', 'BRL'),
      (3, 'conta', 'wise', 'k3', null, 'Wise CLP', 'CLP')`;
    await sql`insert into imports (id, account_id, file_name, file_sha256, format, total, inserted, duplicates) values
      (1, 1, 'conta.ofx', 'a', 'ofx', 0, 0, 0), (2, 2, 'fatura.csv', 'b', 'csv', 0, 0, 0), (3, 3, 'wise.csv', 'c', 'csv', 0, 0, 0)`;

    const [mercado, restaurante, impostos, salario, fatura, aporte] = await Promise.all(
      ["Mercado", "Restaurantes e delivery", "Impostos e taxas", "Salário", "Pagamento de fatura", "Aporte em investimento"].map(cat),
    );
    let id = 0;
    const tx = (account: number, date: string, month: string, amount: number, category: number | null, extra: Record<string, unknown> = {}) => ({
      id: ++id, account_id: account, import_id: account, fingerprint: `h:${id}`, date, month, amount, description: `L${id}`, type: "OTHER", category_id: category, duplicate_of: null, ...extra,
    });
    await sql`insert into transactions ${sql([
      // Novembro
      tx(1, "2026-11-05", "2026-11-01", 800000, salario),           // salário
      tx(1, "2026-11-06", "2026-11-01", -250000, fatura),           // pagou a fatura (movimentação)
      tx(1, "2026-11-07", "2026-11-01", -100000, aporte),           // aporte (movimentação)
      tx(1, "2026-11-08", "2026-11-01", -3000, null),                // saída sem categoria
      tx(1, "2026-11-09", "2026-11-01", 1500, null),                 // entrada sem categoria
      tx(2, "2026-10-20", "2026-11-01", -40000, mercado),            // compra do cartão de outubro, na fatura de novembro
      tx(2, "2026-10-24", "2026-11-01", -9800, impostos),            // anuidade
      tx(2, "2026-10-24", "2026-11-01", 9800, impostos),             // estorno da anuidade
      tx(2, "2026-10-25", "2026-11-01", 250000, fatura),             // pagamento recebido no cartão
      tx(2, "2026-10-26", "2026-11-01", -6000, restaurante),
      tx(2, "2026-10-26", "2026-11-01", -6000, restaurante, { duplicate_of: null }),
      tx(1, "2026-11-10", "2026-11-01", -6000, restaurante, { duplicate_of: 10 }), // cópia descartada: fora
      tx(3, "2026-11-11", "2026-11-01", -15000, mercado),            // outra moeda: fora do resumo em BRL
      // Outubro e setembro, para a comparação
      tx(1, "2026-10-05", "2026-10-01", 800000, salario),
      tx(2, "2026-09-20", "2026-10-01", -20000, mercado),
      tx(1, "2026-09-05", "2026-09-01", 700000, salario),
      tx(2, "2026-08-20", "2026-09-01", -60000, mercado),
    ])}`;
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("lista os meses com dados, do mais recente para o mais antigo, por moeda", async () => {
    expect(await listMonths(sql)).toEqual(["2026-11-01", "2026-10-01", "2026-09-01"]);
    expect(await listMonths(sql, "CLP")).toEqual(["2026-11-01"]);
  });

  it("totais: movimentações e duplicados fora; estorno desconta; sem categoria entra", async () => {
    const s = await monthSummary(sql, "2026-11-01");
    expect(s.income).toBe(800000 + 1500);
    // mercado 40000 + restaurante 12000 + impostos 0 (anuidade estornada) + sem categoria 3000
    expect(s.expenses).toBe(40000 + 12000 + 0 + 3000);
    expect(s.net).toBe(801500 - 55000);
    expect(s.uncategorized).toEqual({ outflow: 3000, outflowCount: 1, inflow: 1500, inflowCount: 1 });
  });

  it("despesas por categoria, da maior para a menor", async () => {
    const s = await monthSummary(sql, "2026-11-01");
    expect(s.expenseCategories.map((c) => [c.name, c.total, c.count])).toEqual([
      ["Mercado", 40000, 1],
      ["Restaurantes e delivery", 12000, 2],
      ["Impostos e taxas", 0, 2],
    ]);
    expect(s.incomeCategories.map((c) => [c.name, c.total])).toEqual([["Salário", 800000]]);
  });

  it("movimentações mostram o que saiu e o que entrou", async () => {
    const s = await monthSummary(sql, "2026-11-01");
    const fatura = s.movements.find((m) => m.name === "Pagamento de fatura")!;
    expect([fatura.outflow, fatura.inflow]).toEqual([250000, 250000]);
    expect(s.movements.find((m) => m.name === "Aporte em investimento")!.outflow).toBe(100000);
  });

  it("compara com a média dos meses anteriores com dados", async () => {
    const s = await monthSummary(sql, "2026-11-01");
    expect(s.previousMonths).toEqual(["2026-10-01", "2026-09-01"]);
    expect(s.expenseCategories.find((c) => c.name === "Mercado")!.previousAverage).toBe((20000 + 60000) / 2);
    expect(s.incomeCategories.find((c) => c.name === "Salário")!.previousAverage).toBe((800000 + 700000) / 2);
    expect(s.expenseCategories.find((c) => c.name === "Restaurantes e delivery")!.previousAverage).toBe(0);
  });

  it("o mais antigo não tem com o que comparar", async () => {
    const s = await monthSummary(sql, "2026-09-01");
    expect(s.previousMonths).toEqual([]);
    expect(s.expenseCategories[0]!.previousAverage).toBeUndefined();
  });

  it("mostra a cobertura de cada conta na moeda do resumo", async () => {
    const nov = await monthSummary(sql, "2026-11-01");
    expect(nov.coverage.map((c) => [c.name, c.count])).toEqual([
      ["Cartão C6", 6],
      ["Conta", 5],
    ]);
  });

  it("filtros de Lançamentos por mês e categoria, sem cópias descartadas", async () => {
    const mercado = await cat("Mercado");
    expect(await countTransactions(sql, { month: "2026-11-01" })).toBe(12);
    expect(await countTransactions(sql, { month: "2026-11-01", category: mercado })).toBe(2);
    expect(await countTransactions(sql, { month: "2026-11-01", category: "sem" })).toBe(2);
    const rows = await listTransactions(sql, { filter: { month: "2026-10-01", category: mercado } });
    expect(rows.map((r) => r.date)).toEqual(["2026-09-20"]);
  });
});
