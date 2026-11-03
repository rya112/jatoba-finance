import type { Sql } from "./db.js";

/** Categorias, regras, limpeza de descrições e revisão. */

export type CategoryKind = "despesa" | "receita" | "movimentacao";
export type Direction = "saida" | "entrada";
export type AccountKind = "conta" | "cartao";
export type CategorySource = "manual" | "regra" | "banco" | "estorno";

export interface Category {
  id: number;
  name: string;
  kind: CategoryKind;
}

export interface Rule {
  id: number;
  pattern: string;
  direction: Direction | null;
  accountKind: AccountKind | null;
  categoryId: number;
  origin: "sistema" | "usuario";
}

export class CategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryError";
  }
}

/** Maiúsculo, sem acentos, espaços simples. É nesta forma que regras e descrições são comparadas. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefixos que os bancos põem antes do que interessa. A descrição original fica guardada. */
const PREFIXES: RegExp[] = [
  /^PIX\s+(ENVIADO|RECEBIDO|TRANSF(ERENCIA)?|AGENDADO)\b\.?\s*(PARA|DE|-|:)?\s*/i,
  /^TRANSF(ERENCIA)?\s+(ENVIADA|RECEBIDA|PIX)\b\.?\s*(PARA|DE|-|:)?\s*/i,
  /^COMPRA\s+(NO\s+)?(CARTAO\s+)?(DE\s+)?DEBITO\b\s*(-|:)?\s*/i,
  /^COMPRA\s+(NO\s+)?CARTAO\b\s*(-|:)?\s*/i,
  /^DEB(ITO)?\.?\s+AUTOMATICO\b\s*(-|:)?\s*/i,
  /^PAGAMENTO\s+DE\s+BOLETO\b\s*(-|:)?\s*/i,
  /^PAG(AMENTO|TO)?\s+BOLETO\b\s*(-|:)?\s*/i,
];

/**
 * Versão legível da descrição, só para exibir: tira prefixos de banco, espaços repetidos e
 * pontuação solta no fim. Se a limpeza deixaria o texto vazio, devolve o original.
 */
export function cleanDescription(raw: string): string {
  const original = raw.replace(/\s+/g, " ").trim();
  let text = original;
  for (const prefix of PREFIXES) {
    const plain = text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const match = plain.match(prefix);
    if (match) {
      text = text.slice(match[0].length);
      break;
    }
  }
  text = text.replace(/[\s\-:;,.*]+$/, "").trim();
  return text === "" ? original : text;
}

/**
 * Categorias do C6 (coluna "Categoria" da fatura) para as do Jatobá.
 * Só as correspondências seguras; o resto fica para a revisão.
 */
export const BANK_CATEGORY_MAP: Readonly<Record<string, string>> = {
  "SUPERMERCADOS / MERCEARIA / PADARIAS / LOJAS DE CONVENIENCIA": "Mercado",
  TRANSPORTE: "Transporte",
  "RELACIONADOS A AUTOMOTIVO": "Transporte",
  "ASSISTENCIA MEDICA E ODONTOLOGICA": "Saúde",
  "TV POR ASSINATURA / SERVICOS DE RADIO": "Assinaturas",
  "RESTAURANTE / LANCHONETE / BAR": "Restaurantes e delivery",
  "VESTUARIO / ROUPAS": "Vestuário",
  "ESPECIALIDADE VAREJO": "Compras",
  "DEPARTAMENTO / DESCONTO": "Compras",
  ELETRICO: "Compras",
  "SERVICOS PESSOAIS": "Cuidados pessoais",
  RECREATIVO: "Lazer",
  ENTRETENIMENTO: "Lazer",
  "ARTE / ARTESANATO / PASSATEMPO": "Lazer",
  EDUCACIONAL: "Educação",
};

export interface Suggestion {
  categoryId: number;
  source: "regra" | "banco";
  ruleId?: number;
}

export interface CategorizeInput {
  description: string;
  amount: number;
  accountKind: AccountKind;
  bankCategory?: string | null;
}

/** Regras do usuário vêm antes das do sistema; dentro de cada grupo, o padrão mais longo (mais específico) vence. */
export function sortRules(rules: readonly Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) =>
      (a.origin === b.origin ? 0 : a.origin === "usuario" ? -1 : 1) ||
      b.pattern.length - a.pattern.length ||
      Number(b.direction !== null) - Number(a.direction !== null) ||
      Number(b.accountKind !== null) - Number(a.accountKind !== null) ||
      a.id - b.id,
  );
}

export function ruleMatches(rule: Rule, t: CategorizeInput): boolean {
  if (rule.direction === "saida" && t.amount >= 0) return false;
  if (rule.direction === "entrada" && t.amount <= 0) return false;
  if (rule.accountKind && rule.accountKind !== t.accountKind) return false;
  return normalizeText(t.description).includes(rule.pattern);
}

/** Sugestão para um lançamento: primeira regra que casar, senão a categoria do banco mapeada. */
export function suggestCategory(
  t: CategorizeInput,
  sortedRules: readonly Rule[],
  categoryIdByName: ReadonlyMap<string, number>,
): Suggestion | undefined {
  const rule = sortedRules.find((r) => ruleMatches(r, t));
  if (rule) return { categoryId: rule.categoryId, source: "regra", ruleId: rule.id };
  if (t.bankCategory) {
    const mapped = BANK_CATEGORY_MAP[normalizeText(t.bankCategory)];
    const id = mapped ? categoryIdByName.get(mapped) : undefined;
    if (id !== undefined) return { categoryId: id, source: "banco" };
  }
  return undefined;
}

/** Entrada com "ESTORNO" no texto: devolução de uma compra. */
export function isRefund(t: CategorizeInput): boolean {
  return t.amount > 0 && /\bESTORNO\b/.test(normalizeText(t.description));
}

// ---------- Banco de dados ----------

/** A compra que um estorno devolve: mesma conta, valor oposto, até 60 dias antes, já com categoria. A mais próxima vence. */
async function findRefundedPurchase(sql: Sql, accountId: number, date: string, amount: number, refundId: string): Promise<{ id: string; categoryId: number } | undefined> {
  const [row] = await sql<{ id: string; category_id: number }[]>`
    select t.id, t.category_id from transactions t
    left join categories c on c.id = t.category_id
    where t.account_id = ${accountId} and t.amount = ${-amount} and t.category_id is not null and t.duplicate_of is null
      and t.date between ${date}::date - 60 and ${date}::date and t.id <> ${refundId}
      and coalesce(c.kind, '') <> 'movimentacao'
    order by ${date}::date - t.date, t.id desc
    limit 1
  `;
  return row ? { id: row.id, categoryId: row.category_id } : undefined;
}

export async function listCategories(sql: Sql): Promise<Category[]> {
  return sql<Category[]>`select id, name, kind from categories order by position, name`;
}

export async function listRules(sql: Sql): Promise<Rule[]> {
  const rows = await sql<{ id: number; pattern: string; direction: Direction | null; account_kind: AccountKind | null; category_id: number; origin: Rule["origin"] }[]>`
    select id, pattern, direction, account_kind, category_id, origin from rules
  `;
  return rows.map((r) => ({ id: r.id, pattern: r.pattern, direction: r.direction, accountKind: r.account_kind, categoryId: r.category_id, origin: r.origin }));
}

/**
 * Preenche a descrição limpa e as sugestões de categoria.
 * Nunca mexe em lançamentos revisados nem em categorias escolhidas à mão.
 * Devolve quantos lançamentos ganharam ou mudaram de sugestão.
 */
export async function categorize(sql: Sql, opts: { onlyIds?: string[]; refundPass?: boolean } = {}): Promise<number> {
  const [categories, rules] = await Promise.all([listCategories(sql), listRules(sql)]);
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const sorted = sortRules(rules);

  const rows = await sql<
    { id: string; account_id: number; date: string; description: string; amount: string; kind: AccountKind; bank_category: string | null; clean_description: string | null; category_id: number | null; rule_id: number | null; category_source: string | null; refund_of: string | null }[]
  >`
    select t.id, t.account_id, to_char(t.date, 'YYYY-MM-DD') as date, t.description, t.amount, a.kind, t.bank_category, t.clean_description,
           t.category_id, t.rule_id, t.category_source, t.refund_of
    from transactions t join accounts a on a.id = t.account_id
    where not t.reviewed and coalesce(t.category_source, '') <> 'manual' and t.duplicate_of is null
      ${opts.onlyIds ? sql`and t.id = any(${sql.array(opts.onlyIds)}::bigint[])` : sql``}
  `;

  const updates: { id: string; clean: string; category: number | null; source: string | null; rule: number | null; refund: string | null }[] = [];
  let changed = 0;
  const refundsWithoutMatch: string[] = [];
  for (const r of rows) {
    const input = { description: r.description, amount: Number(r.amount), accountKind: r.kind, bankCategory: r.bank_category };
    let s: { categoryId: number; source: string; ruleId?: number; refundOf?: string } | undefined = suggestCategory(input, sorted, byName);
    // Estorno sem regra: herda a categoria da compra de mesmo valor, na mesma conta, até 60 dias antes.
    if (!s && isRefund(input)) {
      const purchase = await findRefundedPurchase(sql, r.account_id, r.date, Number(r.amount), r.id);
      if (purchase) s = { categoryId: purchase.categoryId, source: "estorno", refundOf: purchase.id };
      else refundsWithoutMatch.push(r.id);
    }
    const clean = cleanDescription(r.description);
    const category = s?.categoryId ?? null;
    const source = s?.source ?? null;
    const rule = s?.ruleId ?? null;
    const refund = s?.refundOf ?? null;
    if (clean !== r.clean_description || category !== r.category_id || source !== r.category_source || rule !== r.rule_id || refund !== r.refund_of) {
      updates.push({ id: r.id, clean, category, source, rule, refund });
      if (category !== r.category_id) changed++;
    }
  }

  // Uma linha de VALUES por lançamento. (Listas paralelas com unnest desalinham quando há nulos.)
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500);
    const values = chunk.map((u) => [u.id, u.clean, u.category === null ? null : String(u.category), u.source, u.rule === null ? null : String(u.rule), u.refund]);
    await sql`
      update transactions t
      set clean_description = u.clean,
          category_id = u.category::int,
          category_source = u.source,
          rule_id = u.rule::int,
          refund_of = u.refund::bigint
      from (values ${sql(values as string[][])}) as u(id, clean, category, source, rule, refund)
      where t.id = u.id::bigint
    `;
  }
  // A compra pode ter ganhado categoria agora, no mesmo lote do estorno: mais uma passada só para eles.
  if (!opts.refundPass && refundsWithoutMatch.length > 0 && updates.length > 0) {
    changed += await categorize(sql, { onlyIds: refundsWithoutMatch, refundPass: true });
  }
  return changed;
}

export interface ReviewRow {
  id: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  cleanDescription: string;
  accountName: string;
  accountKind: AccountKind;
  categoryId: number | null;
  categorySource: CategorySource | null;
  rulePattern: string | null;
  bankCategory: string | null;
  installment?: string;
  /** Data da compra estornada, quando a sugestão veio dela. */
  refundOfDate?: string;
}

export async function listForReview(sql: Sql, { limit = 50 } = {}): Promise<{ rows: ReviewRow[]; total: number; withSuggestion: number }> {
  const rows = await sql<
    { id: string; date: string; amount: string; currency: string; description: string; clean_description: string | null; account_name: string; kind: AccountKind; category_id: number | null; category_source: CategorySource | null; pattern: string | null; bank_category: string | null; installment_current: number | null; installment_total: number | null; refund_date: string | null }[]
  >`
    select t.id, to_char(t.date, 'YYYY-MM-DD') as date, t.amount, a.currency, t.description, t.clean_description,
           a.name as account_name, a.kind, t.category_id, t.category_source, r.pattern, t.bank_category,
           t.installment_current, t.installment_total, to_char(p.date, 'YYYY-MM-DD') as refund_date
    from transactions t
    join accounts a on a.id = t.account_id
    left join rules r on r.id = t.rule_id
    left join transactions p on p.id = t.refund_of
    where not t.reviewed and t.duplicate_of is null and t.suspect_of is null
    order by (t.category_id is null) desc, t.date desc, t.id desc
    limit ${limit}
  `;
  const [counts] = await sql<{ total: string; with_suggestion: string }[]>`
    select count(*) as total, count(category_id) as with_suggestion from transactions where not reviewed and duplicate_of is null and suspect_of is null
  `;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      description: r.description,
      cleanDescription: r.clean_description ?? cleanDescription(r.description),
      accountName: r.account_name,
      accountKind: r.kind,
      categoryId: r.category_id,
      categorySource: r.category_source,
      rulePattern: r.pattern,
      bankCategory: r.bank_category,
      installment: r.installment_current ? `${r.installment_current}/${r.installment_total}` : undefined,
      refundOfDate: r.refund_date ?? undefined,
    })),
    total: Number(counts?.total ?? 0),
    withSuggestion: Number(counts?.with_suggestion ?? 0),
  };
}

/**
 * Escolha manual de categoria para um lançamento, que fica revisado.
 * Com `rulePattern`, cria também uma regra do usuário (mesma direção e tipo de conta do lançamento)
 * e reaplica as sugestões nos lançamentos ainda não revisados. Devolve quantos outros mudaram.
 */
export async function setCategory(
  sql: Sql,
  transactionId: string,
  categoryId: number,
  opts: { rulePattern?: string } = {},
): Promise<{ otherChanged: number; ruleCreated: boolean }> {
  return sql.begin(async (tx) => {
    const [t] = await tx<{ amount: string; kind: AccountKind }[]>`
      select t.amount, a.kind from transactions t join accounts a on a.id = t.account_id where t.id = ${transactionId}
    `;
    if (!t) throw new CategoryError("Lançamento não encontrado.");
    const [category] = await tx`select id from categories where id = ${categoryId}`;
    if (!category) throw new CategoryError("Categoria não encontrada.");

    await tx`
      update transactions set category_id = ${categoryId}, category_source = 'manual', rule_id = null, reviewed = true
      where id = ${transactionId}
    `;

    let ruleCreated = false;
    let otherChanged = 0;
    const pattern = opts.rulePattern ? normalizeText(opts.rulePattern) : "";
    if (opts.rulePattern !== undefined) {
      if (pattern.length < 3) throw new CategoryError("O texto da regra precisa ter pelo menos 3 letras.");
      const direction: Direction = Number(t.amount) < 0 ? "saida" : "entrada";
      await tx`
        insert into rules (pattern, direction, account_kind, category_id, origin)
        values (${pattern}, ${direction}, ${t.kind}, ${categoryId}, 'usuario')
        on conflict (pattern, direction, account_kind) do update set category_id = excluded.category_id, origin = 'usuario'
      `;
      ruleCreated = true;
      otherChanged = await categorize(tx as unknown as Sql);
    }
    return { otherChanged, ruleCreated };
  });
}

/** Confirma as sugestões dos lançamentos indicados (os que têm sugestão). */
export async function approveSuggestions(sql: Sql, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await sql`
    update transactions set reviewed = true
    where id = any(${sql.array(ids)}::bigint[]) and category_id is not null and not reviewed
  `;
  return result.count;
}
