import type { CategoryKind } from "./categories.js";
import type { Sql } from "./db.js";

/**
 * Resumo de um mês de competência (coluna month: na conta, o mês da data; no cartão, o mês de
 * vencimento da fatura). Cópias de duplicados ficam de fora. Só entram contas na moeda pedida.
 *
 * Valores na menor unidade da moeda. Despesas e saídas são positivas aqui (quanto saiu).
 */

export interface CategoryTotal {
  categoryId: number;
  name: string;
  kind: CategoryKind;
  /** Quanto saiu (despesa) ou entrou (receita/movimentação), já com estornos descontados. */
  total: number;
  count: number;
  /** Separado por sinal: útil nas movimentações (pagar a fatura sai da conta e entra no cartão). */
  outflow: number;
  inflow: number;
  /** Média dos meses anteriores com dados (até 3); undefined se não houver. */
  previousAverage?: number;
}

export interface MonthSummary {
  month: string;
  currency: string;
  income: number;
  expenses: number;
  net: number;
  expenseCategories: CategoryTotal[];
  incomeCategories: CategoryTotal[];
  movements: CategoryTotal[];
  uncategorized: { outflow: number; outflowCount: number; inflow: number; inflowCount: number };
  /** Contas com e sem lançamentos neste mês. */
  coverage: { accountId: number; name: string; kind: "conta" | "cartao"; count: number }[];
  previousMonths: string[];
}

/** Evita "-0" (que apareceria como "−R$ 0,00"). */
const noNegativeZero = (n: number) => (n === 0 ? 0 : n);

/** "2026-11-01" → "2026-10-01". */
export function addMonths(month: string, delta: number): string {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

/** "2026-11" ou "2026-11-15" → "2026-11-01"; undefined se inválido. */
export function parseMonth(value: string | undefined): string | undefined {
  const m = value?.match(/^(\d{4})-(\d{2})/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return undefined;
  return `${m[1]}-${m[2]}-01`;
}

/** Meses que têm lançamentos, do mais recente para o mais antigo. */
export async function listMonths(sql: Sql, currency = "BRL"): Promise<string[]> {
  const rows = await sql<{ month: string }[]>`
    select distinct to_char(t.month, 'YYYY-MM-DD') as month
    from transactions t join accounts a on a.id = t.account_id
    where t.duplicate_of is null and a.currency = ${currency}
    order by 1 desc
  `;
  return rows.map((r) => r.month);
}

export async function monthSummary(sql: Sql, month: string, currency = "BRL"): Promise<MonthSummary> {
  const all = await listMonths(sql, currency);
  const previousMonths = all.filter((m) => m < month).slice(0, 3);
  const months = [month, ...previousMonths];

  const rows = await sql<{ month: string; category_id: number | null; name: string | null; kind: CategoryKind | null; position: number | null; positive: boolean; total: string; n: string }[]>`
    select to_char(t.month, 'YYYY-MM-DD') as month, c.id as category_id, c.name, c.kind, c.position,
           t.amount > 0 as positive, sum(t.amount) as total, count(*) as n
    from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where t.duplicate_of is null and a.currency = ${currency}
      and t.month = any(${sql.array(months)}::date[])
    group by 1, 2, 3, 4, 5, 6
  `;

  // Categoria: soma de tudo (estornos descontam). Sem categoria: separado por sinal.
  const byCategory = new Map<number, { name: string; kind: CategoryKind; position: number; perMonth: Map<string, { total: number; count: number; outflow: number; inflow: number }> }>();
  const uncategorized = { outflow: 0, outflowCount: 0, inflow: 0, inflowCount: 0 };
  for (const r of rows) {
    const total = Number(r.total);
    const count = Number(r.n);
    if (r.category_id === null) {
      if (r.month !== month) continue;
      if (r.positive) {
        uncategorized.inflow += total;
        uncategorized.inflowCount += count;
      } else {
        uncategorized.outflow += -total;
        uncategorized.outflowCount += count;
      }
      continue;
    }
    let entry = byCategory.get(r.category_id);
    if (!entry) {
      entry = { name: r.name!, kind: r.kind!, position: r.position ?? 0, perMonth: new Map() };
      byCategory.set(r.category_id, entry);
    }
    const slot = entry.perMonth.get(r.month) ?? { total: 0, count: 0, outflow: 0, inflow: 0 };
    slot.total += total;
    slot.count += count;
    if (total < 0) slot.outflow += -total;
    else slot.inflow += total;
    entry.perMonth.set(r.month, slot);
  }

  const totals: CategoryTotal[] = [];
  for (const [categoryId, e] of byCategory) {
    const current = e.perMonth.get(month);
    if (!current) continue;
    // Despesa: quanto saiu (sinal invertido). Receita e movimentação: valor como está.
    const sign = e.kind === "despesa" ? -1 : 1;
    const previous = previousMonths.map((m) => e.perMonth.get(m)?.total ?? 0);
    totals.push({
      categoryId,
      name: e.name,
      kind: e.kind,
      total: noNegativeZero(sign * current.total),
      count: current.count,
      outflow: current.outflow,
      inflow: current.inflow,
      previousAverage: previousMonths.length ? noNegativeZero(Math.round((sign * previous.reduce((a, b) => a + b, 0)) / previousMonths.length)) : undefined,
    });
  }
  const byTotal = (a: CategoryTotal, b: CategoryTotal) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name);
  const expenseCategories = totals.filter((t) => t.kind === "despesa").sort(byTotal);
  const incomeCategories = totals.filter((t) => t.kind === "receita").sort(byTotal);
  const movements = totals.filter((t) => t.kind === "movimentacao").sort((a, b) => b.outflow + b.inflow - (a.outflow + a.inflow));

  const expenses = expenseCategories.reduce((s, t) => s + t.total, 0) + uncategorized.outflow;
  const income = incomeCategories.reduce((s, t) => s + t.total, 0) + uncategorized.inflow;

  const coverage = await sql<{ id: number; name: string; kind: "conta" | "cartao"; n: string }[]>`
    select a.id, a.name, a.kind, count(t.id) filter (where t.month = ${month}::date and t.duplicate_of is null) as n
    from accounts a left join transactions t on t.account_id = a.id
    where a.currency = ${currency}
    group by a.id, a.name, a.kind
    order by a.kind, a.name
  `;

  return {
    month,
    currency,
    income,
    expenses,
    net: income - expenses,
    expenseCategories,
    incomeCategories,
    movements,
    uncategorized,
    coverage: coverage.map((c) => ({ accountId: c.id, name: c.name, kind: c.kind, count: Number(c.n) })),
    previousMonths,
  };
}
