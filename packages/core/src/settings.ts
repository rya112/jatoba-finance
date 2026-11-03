import { CategoryError, categorize, normalizeText, type AccountKind, type CategoryKind, type Direction } from "./categories.js";
import type { Sql } from "./db.js";

/**
 * Ajustes: categorias, regras e nomes de contas.
 * Toda mudança que afeta sugestões reaplica a categorização, que nunca mexe em
 * lançamentos revisados nem em categorias escolhidas à mão.
 */

const KINDS: readonly CategoryKind[] = ["despesa", "receita", "movimentacao"];

export interface CategoryUsage {
  id: number;
  name: string;
  kind: CategoryKind;
  transactions: number;
  rules: number;
}

export interface RuleDetail {
  id: number;
  pattern: string;
  direction: Direction | null;
  accountKind: AccountKind | null;
  categoryId: number;
  categoryName: string;
  origin: "sistema" | "usuario";
  /** Lançamentos com sugestão vinda desta regra agora. */
  matches: number;
}

export interface AccountInfo {
  id: number;
  name: string;
  kind: AccountKind;
  currency: string;
  last4: string | null;
  transactions: number;
}

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 40) throw new CategoryError("O nome precisa ter de 2 a 40 caracteres.");
  return name;
}

function checkKind(kind: string): CategoryKind {
  if (!KINDS.includes(kind as CategoryKind)) throw new CategoryError("Tipo de categoria inválido.");
  return kind as CategoryKind;
}

async function ensureUniqueName(sql: Sql, name: string, exceptId?: number): Promise<void> {
  const [clash] = await sql`
    select id from categories where lower(name) = lower(${name}) ${exceptId ? sql`and id <> ${exceptId}` : sql``}
  `;
  if (clash) throw new CategoryError(`Já existe uma categoria chamada “${name}”.`);
}

// ---------- Categorias ----------

export async function listCategoryUsage(sql: Sql): Promise<CategoryUsage[]> {
  const rows = await sql<{ id: number; name: string; kind: CategoryKind; tx: string; rules: string }[]>`
    select c.id, c.name, c.kind,
           (select count(*) from transactions t where t.category_id = c.id and t.duplicate_of is null) as tx,
           (select count(*) from rules r where r.category_id = c.id) as rules
    from categories c
    order by c.position, c.name
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, transactions: Number(r.tx), rules: Number(r.rules) }));
}

export async function createCategory(sql: Sql, input: { name: string; kind: string }): Promise<number> {
  const name = cleanName(input.name);
  const kind = checkKind(input.kind);
  return sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await ensureUniqueName(db, name);
    const [row] = await tx<{ id: number }[]>`
      insert into categories (name, kind, position)
      values (${name}, ${kind}, (select coalesce(max(position), 0) + 5 from categories where kind = ${kind}))
      returning id
    `;
    return row!.id;
  });
}

export async function updateCategory(sql: Sql, id: number, input: { name: string; kind: string }): Promise<void> {
  const name = cleanName(input.name);
  const kind = checkKind(input.kind);
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const [current] = await tx<{ kind: CategoryKind }[]>`select kind from categories where id = ${id}`;
    if (!current) throw new CategoryError("Categoria não encontrada.");
    await ensureUniqueName(db, name, id);
    // Ao mudar de tipo, vai para o fim do novo grupo.
    await tx`
      update categories set name = ${name}, kind = ${kind},
        position = case when kind = ${kind} then position
                        else (select coalesce(max(position), 0) + 5 from categories where kind = ${kind}) end
      where id = ${id}
    `;
  });
}

/**
 * Apaga uma categoria.
 * - Com `moveTo`: lançamentos e regras passam para a outra categoria, como estavam (revisados continuam revisados).
 * - Sem `moveTo`: os lançamentos ficam sem categoria e voltam para a revisão; as regras dela são apagadas.
 * Devolve quantos lançamentos foram afetados.
 */
export async function deleteCategory(sql: Sql, id: number, opts: { moveTo?: number } = {}): Promise<number> {
  return sql.begin(async (tx) => {
    const [current] = await tx`select id from categories where id = ${id}`;
    if (!current) throw new CategoryError("Categoria não encontrada.");
    let affected: number;
    if (opts.moveTo !== undefined) {
      if (opts.moveTo === id) throw new CategoryError("Escolha outra categoria para receber os lançamentos.");
      const [target] = await tx`select id from categories where id = ${opts.moveTo}`;
      if (!target) throw new CategoryError("A categoria de destino não existe.");
      affected = (await tx`update transactions set category_id = ${opts.moveTo} where category_id = ${id}`).count;
      await tx`update rules set category_id = ${opts.moveTo} where category_id = ${id}`;
      // A de destino passa a responder também pelos nomes da apagada (ex.: mapa das categorias do C6).
      await tx`
        update categories d set aliases = array(select distinct unnest(d.aliases || o.aliases || array[o.name]))
        from categories o where d.id = ${opts.moveTo} and o.id = ${id}
      `;
    } else {
      affected = (await tx`
        update transactions set category_id = null, category_source = null, rule_id = null, refund_of = null, reviewed = false
        where category_id = ${id}
      `).count;
    }
    await tx`delete from categories where id = ${id}`;
    await categorize(tx as unknown as Sql);
    return affected;
  });
}

// ---------- Regras ----------

export async function listRuleDetails(sql: Sql): Promise<RuleDetail[]> {
  const rows = await sql<
    { id: number; pattern: string; direction: Direction | null; account_kind: AccountKind | null; category_id: number; name: string; origin: RuleDetail["origin"]; matches: string }[]
  >`
    select r.id, r.pattern, r.direction, r.account_kind, r.category_id, c.name, r.origin,
           (select count(*) from transactions t where t.rule_id = r.id and t.duplicate_of is null) as matches
    from rules r join categories c on c.id = r.category_id
    order by (r.origin = 'usuario') desc, r.pattern, r.id
  `;
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    direction: r.direction,
    accountKind: r.account_kind,
    categoryId: r.category_id,
    categoryName: r.name,
    origin: r.origin,
    matches: Number(r.matches),
  }));
}

export interface RuleInput {
  pattern: string;
  direction: string;
  accountKind: string;
  categoryId: number;
}

function checkRule(input: RuleInput): { pattern: string; direction: Direction | null; accountKind: AccountKind | null } {
  const pattern = normalizeText(input.pattern);
  if (pattern.length < 3) throw new CategoryError("O texto da regra precisa ter pelo menos 3 letras.");
  if (pattern.length > 80) throw new CategoryError("O texto da regra pode ter no máximo 80 caracteres.");
  const direction = input.direction === "saida" || input.direction === "entrada" ? input.direction : input.direction === "" ? null : undefined;
  const accountKind = input.accountKind === "conta" || input.accountKind === "cartao" ? input.accountKind : input.accountKind === "" ? null : undefined;
  if (direction === undefined || accountKind === undefined) throw new CategoryError("Filtro da regra inválido.");
  return { pattern, direction, accountKind };
}

async function ensureCategory(sql: Sql, id: number): Promise<void> {
  const [row] = await sql`select id from categories where id = ${id}`;
  if (!row) throw new CategoryError("Categoria não encontrada.");
}

/** Cria (ou, se já existir com os mesmos filtros, atualiza) uma regra do usuário. Devolve quantos lançamentos ganharam ou mudaram de sugestão. */
export async function createRule(sql: Sql, input: RuleInput): Promise<number> {
  const rule = checkRule(input);
  return sql.begin(async (tx) => {
    await ensureCategory(tx as unknown as Sql, input.categoryId);
    await tx`
      insert into rules (pattern, direction, account_kind, category_id, origin)
      values (${rule.pattern}, ${rule.direction}, ${rule.accountKind}, ${input.categoryId}, 'usuario')
      on conflict (pattern, direction, account_kind) do update set category_id = excluded.category_id, origin = 'usuario'
    `;
    return categorize(tx as unknown as Sql);
  });
}

/** Edita uma regra (de qualquer origem; editada, ela passa a ser do usuário). */
export async function updateRule(sql: Sql, id: number, input: RuleInput): Promise<number> {
  const rule = checkRule(input);
  return sql.begin(async (tx) => {
    const [current] = await tx`select id from rules where id = ${id}`;
    if (!current) throw new CategoryError("Regra não encontrada.");
    await ensureCategory(tx as unknown as Sql, input.categoryId);
    const [clash] = await tx`
      select id from rules where pattern = ${rule.pattern} and direction is not distinct from ${rule.direction}
        and account_kind is not distinct from ${rule.accountKind} and id <> ${id}
    `;
    if (clash) throw new CategoryError("Já existe outra regra com esse texto e esses filtros.");
    await tx`
      update rules set pattern = ${rule.pattern}, direction = ${rule.direction}, account_kind = ${rule.accountKind},
        category_id = ${input.categoryId}, origin = 'usuario'
      where id = ${id}
    `;
    return categorize(tx as unknown as Sql);
  });
}

export async function deleteRule(sql: Sql, id: number): Promise<number> {
  return sql.begin(async (tx) => {
    const result = await tx`delete from rules where id = ${id}`;
    if (result.count === 0) throw new CategoryError("Regra não encontrada.");
    return categorize(tx as unknown as Sql);
  });
}

// ---------- Contas ----------

export async function listAccounts(sql: Sql): Promise<AccountInfo[]> {
  const rows = await sql<{ id: number; name: string; kind: AccountKind; currency: string; last4: string | null; n: string }[]>`
    select a.id, a.name, a.kind, a.currency, a.last4,
           (select count(*) from transactions t where t.account_id = a.id and t.duplicate_of is null) as n
    from accounts a order by a.kind, a.name
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, currency: r.currency, last4: r.last4, transactions: Number(r.n) }));
}

export async function renameAccount(sql: Sql, id: number, rawName: string): Promise<void> {
  const name = rawName.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 40) throw new CategoryError("O nome precisa ter de 2 a 40 caracteres.");
  const result = await sql`update accounts set name = ${name} where id = ${id}`;
  if (result.count === 0) throw new CategoryError("Conta não encontrada.");
}
