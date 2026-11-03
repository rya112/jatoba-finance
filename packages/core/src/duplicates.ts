import type { Sql } from "./db.js";

/**
 * Possíveis duplicados: o C6 às vezes muda o texto de um lançamento entre uma exportação e outra.
 * Aí o conteúdo não bate e a cópia entra. A importação marca como suspeito todo lançamento novo
 * com mesma conta, data e valor de um já existente (de outro arquivo) e texto diferente,
 * e quem decide é você.
 */

export class DuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateError";
  }
}

/**
 * Marca suspeitos entre os lançamentos recém-inseridos. `filePrints` são as impressões de todos
 * os lançamentos do arquivo: se o arquivo também trouxe o lançamento antigo, os dois existem
 * de verdade (por exemplo, duas entradas iguais no mesmo dia) e não há suspeita.
 */
export async function flagSuspects(sql: Sql, insertedIds: string[], filePrints: string[]): Promise<number> {
  if (insertedIds.length === 0) return 0;
  const result = await sql`
    update transactions n set suspect_of = o.id
    from (
      select distinct on (n.id) n.id as new_id, e.id
      from transactions n
      join transactions e on e.account_id = n.account_id and e.date = n.date and e.amount = n.amount
        and e.import_id <> n.import_id and e.duplicate_of is null and e.suspect_of is null
        and upper(e.description) <> upper(n.description)
      where n.id = any(${sql.array(insertedIds)}::bigint[])
        and not (e.fingerprint = any(${sql.array(filePrints)}::text[]))
      order by n.id, e.id
    ) o
    where n.id = o.new_id
  `;
  return result.count;
}

export interface SuspectPair {
  id: string;
  date: string;
  amount: number;
  currency: string;
  accountName: string;
  description: string;
  fileName: string;
  original: { id: string; description: string; fileName: string; categoryName: string | null; reviewed: boolean };
}

export async function listSuspects(sql: Sql): Promise<SuspectPair[]> {
  const rows = await sql<
    {
      id: string; date: string; amount: string; currency: string; account_name: string; description: string; file_name: string;
      o_id: string; o_description: string; o_file_name: string; o_category: string | null; o_reviewed: boolean;
    }[]
  >`
    select n.id, to_char(n.date, 'YYYY-MM-DD') as date, n.amount, a.currency, a.name as account_name,
           coalesce(n.clean_description, n.description) as description, ni.file_name,
           o.id as o_id, coalesce(o.clean_description, o.description) as o_description, oi.file_name as o_file_name,
           c.name as o_category, o.reviewed as o_reviewed
    from transactions n
    join transactions o on o.id = n.suspect_of
    join accounts a on a.id = n.account_id
    join imports ni on ni.id = n.import_id
    join imports oi on oi.id = o.import_id
    left join categories c on c.id = o.category_id
    where n.duplicate_of is null
    order by n.date desc, n.id
  `;
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: Number(r.amount),
    currency: r.currency,
    accountName: r.account_name,
    description: r.description,
    fileName: r.file_name,
    original: { id: r.o_id, description: r.o_description, fileName: r.o_file_name, categoryName: r.o_category, reviewed: r.o_reviewed },
  }));
}

/**
 * Decide um suspeito.
 * - "duplicado": o lançamento novo vira cópia do antigo e some de listas e somas (o antigo fica como está).
 * - "distinto": são lançamentos diferentes; a suspeita é retirada.
 */
export async function resolveSuspect(sql: Sql, id: string, decision: "duplicado" | "distinto"): Promise<void> {
  const [row] = await sql<{ suspect_of: string | null }[]>`select suspect_of from transactions where id = ${id}`;
  if (!row?.suspect_of) throw new DuplicateError("Este lançamento não está marcado como possível duplicado.");
  if (decision === "duplicado") {
    await sql`
      update transactions set duplicate_of = suspect_of, suspect_of = null, reviewed = true,
        category_id = null, category_source = null, rule_id = null
      where id = ${id}
    `;
  } else {
    await sql`update transactions set suspect_of = null where id = ${id}`;
  }
}

export async function countSuspects(sql: Sql): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*) as n from transactions where suspect_of is not null and duplicate_of is null`;
  return Number(row?.n ?? 0);
}
