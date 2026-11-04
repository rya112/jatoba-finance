import { cleanDescription, normalizeText } from "./categories.js";
import type { Sql } from "./db.js";

/**
 * Assinaturas: gastos que se repetem por volta de uma vez por mês, no mesmo estabelecimento,
 * com valor parecido. Detectadas a partir dos lançamentos; nada precisa ser cadastrado.
 * Parcelas, estornos, movimentações e cópias de duplicados ficam de fora.
 */

export interface SubscriptionCharge {
  date: string;
  /** Quanto saiu (positivo). */
  amount: number;
  description: string;
  categoryName: string | null;
  /** Conta de origem: a detecção é por conta (a mesma assinatura pode mudar de cartão). */
  account?: string;
}

export interface Subscription {
  /** Chave do estabelecimento (descrição sem números nem pontuação). */
  key: string;
  name: string;
  categoryName: string | null;
  accountName?: string;
  lastAmount: number;
  /** Valor anterior, quando o último foi diferente (reajuste). */
  previousAmount?: number;
  firstDate: string;
  lastDate: string;
  nextDate: string;
  charges: number;
  /** Cobrou nos últimos 45 dias até o último dia importado da conta. */
  active: boolean;
  /** A próxima cobrança prevista já passou do último dia importado e não apareceu. */
  late: boolean;
}

const MIN_CHARGES = 2;
const AMOUNT_TOLERANCE = 0.2;
const INTERVAL = { min: 25, max: 35 };
const ACTIVE_DAYS = 45;
/** Parcela escrita no texto ("PARC 03/10"), para lançamentos gravados antes de o OFX reconhecer parcelas. Regex do Postgres. */
const INSTALLMENT_IN_TEXT = String.raw`\mPARC(ELA)?\.?\s*\d`;

/** "NETFLIX.COM 0123*45 SAO PAULO" → "NETFLIX COM SAO PAULO": sem números, pontuação e espaços repetidos. */
export function merchantKey(description: string): string {
  return normalizeText(cleanDescription(description))
    .replace(/\S*\d\S*/g, " ")
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DAY = 24 * 60 * 60_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Mesmo dia do mês seguinte (ou o último dia, se o mês for mais curto). */
export function nextMonthSameDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Detecção pura, para testar sem banco. `charges` em qualquer ordem. */
export function detectSubscriptions(
  charges: readonly SubscriptionCharge[],
  today: string,
  /** Último dia importado de cada conta. "Parou" e "atrasada" contam a partir dele, não de hoje. */
  lastImported: Readonly<Record<string, string>> = {},
): Subscription[] {
  const reference = (account?: string) => {
    const seen = account ? lastImported[account] : undefined;
    return seen && seen < today ? seen : today;
  };
  const groups = new Map<string, { key: string; list: SubscriptionCharge[] }>();
  for (const c of charges) {
    const key = merchantKey(c.description);
    if (key.length < 3) continue;
    const group = JSON.stringify([c.account ?? "", key]);
    const entry = groups.get(group) ?? { key, list: [] };
    entry.list.push(c);
    groups.set(group, entry);
  }

  const found: Subscription[] = [];
  for (const { key, list } of groups.values()) {
    if (list.length < MIN_CHARGES) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));

    // Frequente demais (várias vezes no mesmo mês) não é assinatura.
    const months = new Set(list.map((c) => c.date.slice(0, 7)));
    if (list.length > months.size * 1.3) continue;

    // Valores parecidos: a maior parte perto da mediana.
    const mid = median(list.map((c) => c.amount));
    const regular = list.filter((c) => Math.abs(c.amount - mid) <= mid * AMOUNT_TOLERANCE);
    if (regular.length < MIN_CHARGES || regular.length < list.length * 0.75) continue;

    // Por volta de uma vez por mês.
    const intervals = regular.slice(1).map((c, i) => (toTime(c.date) - toTime(regular[i]!.date)) / DAY);
    const interval = median(intervals);
    if (interval < INTERVAL.min || interval > INTERVAL.max) continue;

    const last = regular.at(-1)!;
    const previous = regular.at(-2)!;
    found.push({
      key,
      name: cleanDescription(last.description),
      categoryName: last.categoryName,
      accountName: last.account,
      lastAmount: last.amount,
      previousAmount: Math.abs(last.amount - previous.amount) > previous.amount * 0.01 ? previous.amount : undefined,
      firstDate: regular[0]!.date,
      lastDate: last.date,
      nextDate: nextMonthSameDay(last.date),
      charges: regular.length,
      active: (toTime(reference(last.account)) - toTime(last.date)) / DAY <= ACTIVE_DAYS,
      late: nextMonthSameDay(last.date) < reference(last.account),
    });
  }
  return found.sort((a, b) => Number(b.active) - Number(a.active) || b.lastAmount - a.lastAmount || a.name.localeCompare(b.name));
}

export interface SubscriptionList {
  active: Subscription[];
  stopped: Subscription[];
  ignored: { key: string; name: string }[];
  /** Soma do último valor das ativas. */
  monthlyTotal: number;
}

export async function listSubscriptions(sql: Sql, today: string, currency = "BRL"): Promise<SubscriptionList> {
  const rows = await sql<{ date: string; amount: string; description: string; category: string | null; account: string }[]>`
    select to_char(t.date, 'YYYY-MM-DD') as date, -t.amount as amount, t.description, c.name as category, a.name as account
    from transactions t
    join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where t.amount < 0 and t.duplicate_of is null and t.installment_total is null
      and t.description !~* ${INSTALLMENT_IN_TEXT}
      and a.currency = ${currency}
      and coalesce(c.kind, '') <> 'movimentacao'
      and t.date >= ${today}::date - 400
  `;
  const ignored = await sql<{ key: string; name: string }[]>`select key, name from subscription_ignores order by name`;
  const skip = new Set(ignored.map((i) => i.key));
  const seen = await sql<{ account: string; last: string }[]>`
    select a.name as account, to_char(max(t.date), 'YYYY-MM-DD') as last
    from transactions t join accounts a on a.id = t.account_id
    where t.duplicate_of is null group by a.name
  `;
  const all = detectSubscriptions(
    rows.map((r) => ({ date: r.date, amount: Number(r.amount), description: r.description, categoryName: r.category, account: r.account })),
    today,
    Object.fromEntries(seen.map((s) => [s.account, s.last])),
  ).filter((s) => !skip.has(s.key));
  const active = all.filter((s) => s.active);
  return {
    active,
    stopped: all.filter((s) => !s.active),
    ignored,
    monthlyTotal: active.reduce((sum, s) => sum + s.lastAmount, 0),
  };
}

/** "Não é assinatura": some da lista (e pode voltar com unignoreSubscription). */
export async function ignoreSubscription(sql: Sql, key: string, name: string): Promise<void> {
  const clean = key.trim();
  if (clean.length < 3 || clean.length > 120) throw new Error("Chave de assinatura inválida.");
  await sql`
    insert into subscription_ignores (key, name) values (${clean}, ${name.trim().slice(0, 120) || clean})
    on conflict (key) do nothing
  `;
}

export async function unignoreSubscription(sql: Sql, key: string): Promise<void> {
  await sql`delete from subscription_ignores where key = ${key}`;
}
