import { categorize } from "./categories.js";
import type { Sql } from "./db.js";

/** Um lançamento com todos os detalhes, para a página de edição. */
export interface TransactionDetail {
  id: string;
  date: string;
  month: string;
  amount: number;
  currency: string;
  description: string;
  cleanDescription: string | null;
  type: string;
  accountId: number;
  accountName: string;
  accountKind: "conta" | "cartao";
  billing: boolean;
  installment?: string;
  cardLast4: string | null;
  bankCategory: string | null;
  foreign?: { amount: number; currency: string; rate: string | null };
  categoryId: number | null;
  categoryName: string | null;
  categorySource: "manual" | "regra" | "banco" | "estorno" | "ia" | null;
  rulePattern: string | null;
  reviewed: boolean;
  fileName: string;
  importedAt: Date;
  duplicateOf: string | null;
  suspectOf: string | null;
  goalName: string | null;
}

export async function getTransaction(sql: Sql, id: string): Promise<TransactionDetail | undefined> {
  if (!/^\d{1,18}$/.test(id)) return undefined;
  const [r] = await sql<
    {
      id: string; date: string; month: string; amount: string; currency: string; description: string; clean_description: string | null; type: string;
      account_id: number; account_name: string; kind: "conta" | "cartao"; source: string; installment_current: number | null; installment_total: number | null;
      card_last4: string | null; bank_category: string | null; foreign_amount: string | null; foreign_currency: string | null; foreign_rate: string | null;
      category_id: number | null; category_name: string | null; category_source: TransactionDetail["categorySource"]; pattern: string | null; reviewed: boolean;
      file_name: string; imported_at: Date; duplicate_of: string | null; suspect_of: string | null; goal_name: string | null;
    }[]
  >`
    select t.id, to_char(t.date, 'YYYY-MM-DD') as date, to_char(t.month, 'YYYY-MM-DD') as month, t.amount, a.currency, t.description, t.clean_description, t.type,
           a.id as account_id, a.name as account_name, a.kind, a.source, t.installment_current, t.installment_total, t.card_last4, t.bank_category,
           t.foreign_amount, t.foreign_currency, t.foreign_rate, t.category_id, c.name as category_name, t.category_source, r.pattern, t.reviewed,
           i.file_name, i.created_at as imported_at, t.duplicate_of, t.suspect_of,
           (select g.name from goal_entries e join goals g on g.id = e.goal_id where e.transaction_id = t.id) as goal_name
    from transactions t
    join accounts a on a.id = t.account_id
    join imports i on i.id = t.import_id
    left join categories c on c.id = t.category_id
    left join rules r on r.id = t.rule_id
    where t.id = ${id}
  `;
  if (!r) return undefined;
  return {
    id: r.id,
    date: r.date,
    month: r.month,
    amount: Number(r.amount),
    currency: r.currency,
    description: r.description,
    cleanDescription: r.clean_description,
    type: r.type,
    accountId: r.account_id,
    accountName: r.account_name,
    accountKind: r.kind,
    billing: r.source === "c6-fatura",
    installment: r.installment_current ? `${r.installment_current}/${r.installment_total}` : undefined,
    cardLast4: r.card_last4,
    bankCategory: r.bank_category,
    foreign: r.foreign_amount ? { amount: Number(r.foreign_amount), currency: r.foreign_currency ?? "", rate: r.foreign_rate } : undefined,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categorySource: r.category_source,
    rulePattern: r.pattern,
    reviewed: r.reviewed,
    fileName: r.file_name,
    importedAt: r.imported_at,
    duplicateOf: r.duplicate_of,
    suspectOf: r.suspect_of,
    goalName: r.goal_name,
  };
}

/**
 * Desfaz a revisão: tira a categoria escolhida e devolve o lançamento para a Revisar,
 * já com a sugestão automática (regra, categoria do banco ou estorno), se houver.
 */
export async function reopenReview(sql: Sql, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const result = await tx`
      update transactions set category_id = null, category_source = null, rule_id = null, refund_of = null, reviewed = false
      where id = ${id} and duplicate_of is null
    `;
    if (result.count === 0) throw new Error("Lançamento não encontrado.");
    await categorize(tx as unknown as Sql, { onlyIds: [id] });
  });
}
