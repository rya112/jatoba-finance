import type { Sql } from "./db.js";
import { toCents } from "./money.js";

/**
 * Metas: valor alvo, prazo opcional e o quanto já foi guardado.
 * O progresso é a soma das entradas da meta: valores registrados à mão (guardei/retirei)
 * e aportes/resgates do extrato ligados a ela.
 */

export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalError";
  }
}

export type GoalStatus = "atingida" | "no-ritmo" | "abaixo" | "prazo-vencido" | "sem-prazo" | "sem-historico";

export interface GoalProgress {
  id: number;
  name: string;
  target: number;
  saved: number;
  remaining: number;
  /** 0 a 100. */
  percent: number;
  deadline?: string;
  /** Meses de agora até o prazo, contando o atual. */
  monthsLeft?: number;
  /** Quanto guardar por mês para chegar no prazo. */
  monthlyNeeded?: number;
  /** Média por mês nos últimos 3 meses (sem o saldo inicial). */
  monthlyPace: number;
  /** Sem prazo: em quantos meses chega no ritmo atual. */
  monthsAtPace?: number;
  status: GoalStatus;
  archived: boolean;
}

export interface GoalEntry {
  id: string;
  date: string;
  amount: number;
  note: string | null;
  initial: boolean;
  transactionId: string | null;
  description: string | null;
}

export interface InvestmentTransaction {
  id: string;
  date: string;
  amount: number;
  description: string;
  categoryName: string;
  accountName: string;
}

/** "10000", "10.000", "R$ 10.000,50" → centavos positivos. */
export function parseAmount(raw: string): number {
  const value = raw.trim().replace(/^R\$\s*/i, "");
  let cents: number;
  try {
    cents = toCents(value);
  } catch {
    throw new GoalError("Valor inválido. Use, por exemplo, 10000 ou 10.000,00.");
  }
  if (cents <= 0) throw new GoalError("O valor precisa ser maior que zero.");
  return cents;
}

/** "2027-12" → "2027-12-01"; vazio → undefined. */
export function parseDeadline(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  const m = value.match(/^(\d{4})-(\d{2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new GoalError("Prazo inválido. Use mês e ano.");
  return `${m[1]}-${m[2]}-01`;
}

function monthIndex(iso: string): number {
  return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
}

/** Calcula o progresso a partir dos totais. Pura, para testar sem banco. */
export function computeProgress(
  goal: { id: number; name: string; target: number; deadline?: string; archived: boolean },
  saved: number,
  lastThreeMonths: number,
  today: string,
): GoalProgress {
  const remaining = Math.max(0, goal.target - saved);
  const percent = Math.max(0, Math.min(100, Math.floor((saved / goal.target) * 100)));
  const monthlyPace = Math.round(lastThreeMonths / 3);
  const base = { ...goal, saved, remaining, percent, monthlyPace };

  if (remaining === 0) return { ...base, status: "atingida" };
  if (goal.deadline) {
    const monthsLeft = monthIndex(goal.deadline) - monthIndex(today) + 1;
    if (monthsLeft <= 0) return { ...base, monthsLeft: 0, status: "prazo-vencido" };
    const monthlyNeeded = Math.ceil(remaining / monthsLeft);
    return { ...base, monthsLeft, monthlyNeeded, status: monthlyPace >= monthlyNeeded ? "no-ritmo" : "abaixo" };
  }
  if (monthlyPace <= 0) return { ...base, status: "sem-historico" };
  return { ...base, monthsAtPace: Math.ceil(remaining / monthlyPace), status: "sem-prazo" };
}

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60) throw new GoalError("O nome precisa ter de 2 a 60 caracteres.");
  return name;
}

/** Metas com progresso. `today` em AAAA-MM-DD (a data local de quem usa). */
export async function listGoals(sql: Sql, today: string, { archived = false } = {}): Promise<GoalProgress[]> {
  const from = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  from.setUTCMonth(from.getUTCMonth() - 2);
  const rows = await sql<{ id: number; name: string; target: string; deadline: string | null; archived: boolean; saved: string; recent: string }[]>`
    select g.id, g.name, g.target, to_char(g.deadline, 'YYYY-MM-DD') as deadline, g.archived,
           coalesce(sum(e.amount), 0) as saved,
           coalesce(sum(e.amount) filter (where not e.initial and e.date >= ${from.toISOString().slice(0, 10)}::date and e.date <= ${today}::date), 0) as recent
    from goals g left join goal_entries e on e.goal_id = g.id
    where g.archived = ${archived}
    group by g.id
    order by g.deadline nulls last, g.created_at, g.id
  `;
  return rows.map((r) =>
    computeProgress(
      { id: r.id, name: r.name, target: Number(r.target), deadline: r.deadline ?? undefined, archived: r.archived },
      Number(r.saved),
      Number(r.recent),
      today,
    ),
  );
}

export async function createGoal(sql: Sql, input: { name: string; target: string; deadline: string; saved: string }, today: string): Promise<number> {
  const name = cleanName(input.name);
  const target = parseAmount(input.target);
  const deadline = parseDeadline(input.deadline);
  const saved = input.saved.trim() === "" ? 0 : parseAmount(input.saved);
  return sql.begin(async (tx) => {
    const [goal] = await tx<{ id: number }[]>`
      insert into goals (name, target, deadline) values (${name}, ${target}, ${deadline ?? null}) returning id
    `;
    if (saved > 0) {
      await tx`insert into goal_entries (goal_id, date, amount, note, initial) values (${goal!.id}, ${today}, ${saved}, 'Já guardado ao criar a meta', true)`;
    }
    return goal!.id;
  });
}

export async function updateGoal(sql: Sql, id: number, input: { name: string; target: string; deadline: string }): Promise<void> {
  const name = cleanName(input.name);
  const target = parseAmount(input.target);
  const deadline = parseDeadline(input.deadline);
  const result = await sql`update goals set name = ${name}, target = ${target}, deadline = ${deadline ?? null} where id = ${id}`;
  if (result.count === 0) throw new GoalError("Meta não encontrada.");
}

export async function setGoalArchived(sql: Sql, id: number, archived: boolean): Promise<void> {
  const result = await sql`update goals set archived = ${archived} where id = ${id}`;
  if (result.count === 0) throw new GoalError("Meta não encontrada.");
}

/** Apaga a meta e o histórico dela. Os lançamentos do extrato continuam; só deixam de estar ligados. */
export async function deleteGoal(sql: Sql, id: number): Promise<void> {
  const result = await sql`delete from goals where id = ${id}`;
  if (result.count === 0) throw new GoalError("Meta não encontrada.");
}

/** Registra um valor guardado (`kind` "guardar") ou retirado ("retirar"). */
export async function addGoalEntry(
  sql: Sql,
  goalId: number,
  input: { kind: string; amount: string; date: string; note: string },
): Promise<void> {
  if (input.kind !== "guardar" && input.kind !== "retirar") throw new GoalError("Escolha guardar ou retirar.");
  const cents = parseAmount(input.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new GoalError("Data inválida.");
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const [goal] = await sql`select id from goals where id = ${goalId}`;
  if (!goal) throw new GoalError("Meta não encontrada.");
  await sql`
    insert into goal_entries (goal_id, date, amount, note) values (${goalId}, ${input.date}, ${input.kind === "guardar" ? cents : -cents}, ${note})
  `;
}

export async function deleteGoalEntry(sql: Sql, entryId: string): Promise<void> {
  const result = await sql`delete from goal_entries where id = ${entryId}`;
  if (result.count === 0) throw new GoalError("Registro não encontrado.");
}

export async function listGoalEntries(sql: Sql, goalId: number, { limit = 20 } = {}): Promise<GoalEntry[]> {
  const rows = await sql<{ id: string; date: string; amount: string; note: string | null; initial: boolean; transaction_id: string | null; description: string | null }[]>`
    select e.id, to_char(e.date, 'YYYY-MM-DD') as date, e.amount, e.note, e.initial, e.transaction_id,
           coalesce(t.clean_description, t.description) as description
    from goal_entries e left join transactions t on t.id = e.transaction_id
    where e.goal_id = ${goalId}
    order by e.date desc, e.id desc
    limit ${limit}
  `;
  return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), note: r.note, initial: r.initial, transactionId: r.transaction_id, description: r.description }));
}

/** Aportes e resgates do extrato que ainda não estão ligados a nenhuma meta. */
export async function listUnassignedInvestments(sql: Sql, { limit = 30 } = {}): Promise<InvestmentTransaction[]> {
  const rows = await sql<{ id: string; date: string; amount: string; description: string; category: string; account: string }[]>`
    select t.id, to_char(t.date, 'YYYY-MM-DD') as date, t.amount, coalesce(t.clean_description, t.description) as description,
           c.name as category, a.name as account
    from transactions t
    join categories c on c.id = t.category_id
    join accounts a on a.id = t.account_id
    where t.duplicate_of is null
      and (c.aliases && array['Aporte em investimento', 'Resgate de investimento']::text[]
           or c.name in ('Aporte em investimento', 'Resgate de investimento'))
      and not exists (select 1 from goal_entries e where e.transaction_id = t.id)
    order by t.date desc, t.id desc
    limit ${limit}
  `;
  return rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount), description: r.description, categoryName: r.category, accountName: r.account }));
}

/** Liga um aporte (saída da conta = guardou) ou resgate (entrada = retirou) a uma meta. */
export async function assignTransaction(sql: Sql, transactionId: string, goalId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const [goal] = await tx`select id from goals where id = ${goalId}`;
    if (!goal) throw new GoalError("Meta não encontrada.");
    const [t] = await tx<{ date: string; amount: string }[]>`
      select to_char(date, 'YYYY-MM-DD') as date, amount from transactions where id = ${transactionId} and duplicate_of is null
    `;
    if (!t) throw new GoalError("Lançamento não encontrado.");
    const [taken] = await tx`select goal_id from goal_entries where transaction_id = ${transactionId}`;
    if (taken) throw new GoalError("Este lançamento já está ligado a uma meta.");
    await tx`insert into goal_entries (goal_id, date, amount, transaction_id) values (${goalId}, ${t.date}, ${-Number(t.amount)}, ${transactionId})`;
  });
}
