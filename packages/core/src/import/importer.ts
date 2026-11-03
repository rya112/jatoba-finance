import { createHash } from "node:crypto";
import type { Sql } from "../db.js";
import { categorize } from "../categories.js";
import { flagSuspects } from "../duplicates.js";
import { decodeText, detectLayout, parseCsvStatement, CsvError } from "./csv.js";
import { parseOfx } from "./ofx.js";
import type { ImportResult, Statement, Transaction } from "./types.js";

/** Grava extratos lidos no banco, sem duplicar lançamentos já importados. */

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportSummary {
  importId: number;
  accountId: number;
  accountName: string;
  format: string;
  firstDate?: string;
  lastDate?: string;
  total: number;
  inserted: number;
  duplicates: number;
  /** Novos que parecem cópia de um já existente com outro texto; ficam para você decidir. */
  suspects: number;
}

export interface ImportOutcome {
  fileName: string;
  /** Quando este mesmo arquivo (mesmo conteúdo) já tinha sido importado. */
  previouslyImportedAt?: Date;
  statements: ImportSummary[];
  warnings: string[];
}

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** "2026-10-17" → "2026-10-01". */
function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Mês de vencimento de uma fatura: último dia de compra + 10 dias (bate com os nomes de arquivo do C6). */
export function billingMonth(lastPurchaseDate: string): string {
  const d = new Date(`${lastPurchaseDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 10);
  return monthOf(d.toISOString().slice(0, 10));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDescription(value: string): string {
  return value.normalize("NFC").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Impressão digital de cada lançamento: data, valor, descrição, cartão e parcela, mais o
 * número da ocorrência no arquivo. Assim, dois cafés iguais no mesmo dia continuam sendo dois,
 * e o mesmo período exportado de novo gera as mesmas impressões e não duplica nada.
 *
 * O FITID do OFX NÃO entra: o C6 gera FITIDs novos a cada exportação (ver migração 0003).
 * Ele continua guardado em external_id, só como referência.
 */
export function fingerprints(transactions: readonly Transaction[]): string[] {
  const seen = new Map<string, number>();
  return transactions.map((t) => {
    const base = [
      t.date,
      t.amount,
      normalizeDescription(t.description),
      t.cardLast4 ?? "",
      t.installment ? `${t.installment.current}/${t.installment.total}` : "",
    ].join("|");
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return `h:${sha256(base).slice(0, 32)}#${occurrence}`;
  });
}

/** Lê o arquivo e descobre o formato: OFX ou um dos CSVs conhecidos. */
export function readStatementFile(bytes: Uint8Array): ImportResult & { format: string; source: string } {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ImportError("Arquivo grande demais (máximo de 10 MB).");
  const text = decodeText(bytes.subarray(0, 4096));
  if (/<OFX>/i.test(decodeText(bytes))) {
    return { ...parseOfx(bytes), format: "ofx", source: "ofx" };
  }
  const layout = detectLayout(decodeText(bytes));
  if (!layout) {
    throw new ImportError(
      text.trim() === ""
        ? "O arquivo está vazio."
        : "Formato não reconhecido. O Jatobá lê OFX e o CSV da fatura do C6; outros bancos chegam aos poucos.",
    );
  }
  try {
    return { ...parseCsvStatement(bytes, layout), format: "csv", source: layout.id };
  } catch (error) {
    if (error instanceof CsvError) throw new ImportError(error.message);
    throw error;
  }
}

function accountKey(source: string, s: Statement): { keyHash: string; last4?: string; name: string } {
  const { bankId = "", branchId = "", accountId } = s.account;
  const digits = accountId.replace(/\D/g, "");
  const last4 = source === "ofx" && digits.length >= 4 ? digits.slice(-4) : undefined;
  const label = s.kind === "conta" ? "Conta" : "Cartão";
  const name = source === "c6-fatura" ? "Cartão C6" : last4 ? `${label} final ${last4}` : label;
  return { keyHash: sha256(`${bankId}|${branchId}|${accountId}`), last4, name };
}

export async function importFile(sql: Sql, fileName: string, bytes: Uint8Array): Promise<ImportOutcome> {
  const { statements, warnings, format, source } = readStatementFile(bytes);
  const fileSha = sha256(bytes);

  return sql.begin(async (tx) => {
    const [previous] = await tx<{ created_at: Date }[]>`
      select created_at from imports where file_sha256 = ${fileSha} order by created_at limit 1
    `;
    const summaries: ImportSummary[] = [];
    const insertedIds: string[] = [];

    for (const statement of statements) {
      const { keyHash, last4, name } = accountKey(source, statement);
      const [account] = await tx<{ id: number; name: string }[]>`
        insert into accounts (kind, source, key_hash, last4, name, currency)
        values (${statement.kind}, ${source}, ${keyHash}, ${last4 ?? null}, ${name}, ${statement.currency})
        on conflict (source, key_hash) do update set kind = excluded.kind
        returning id, name
      `;
      const dates = statement.transactions.map((t) => t.date).sort();
      const [imp] = await tx<{ id: number }[]>`
        insert into imports (account_id, file_name, file_sha256, format, first_date, last_date, total, inserted, duplicates, warnings)
        values (${account!.id}, ${fileName}, ${fileSha}, ${format}, ${dates[0] ?? null}, ${dates.at(-1) ?? null},
                ${statement.transactions.length}, 0, 0, ${tx.json(warnings)})
        returning id
      `;

      const prints = fingerprints(statement.transactions);
      const faturaMonth = statement.billing === "fatura" && dates.length > 0 ? billingMonth(dates.at(-1)!) : undefined;
      const rows = statement.transactions.map((t, i) => ({
        account_id: account!.id,
        import_id: imp!.id,
        fingerprint: prints[i]!,
        external_id: t.externalId ?? null,
        date: t.date,
        month: faturaMonth ?? monthOf(t.date),
        amount: t.amount,
        description: t.description,
        type: t.type,
        installment_current: t.installment?.current ?? null,
        installment_total: t.installment?.total ?? null,
        card_last4: t.cardLast4 ?? null,
        bank_category: t.bankCategory ?? null,
        foreign_amount: t.foreign?.amount ?? null,
        foreign_currency: t.foreign?.currency ?? null,
        foreign_rate: t.foreign?.rate ?? null,
      }));

      let inserted = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const result = await tx<{ id: string }[]>`
          insert into transactions ${tx(chunk)}
          on conflict (account_id, fingerprint) do nothing
          returning id
        `;
        inserted += result.length;
        insertedIds.push(...result.map((r) => r.id));
      }
      const duplicates = rows.length - inserted;
      // Fatura exportada antes de fechar e de novo depois: o que já existia passa para o mês da fatura mais recente.
      if (faturaMonth && duplicates > 0) {
        await tx`
          update transactions set month = ${faturaMonth}
          where account_id = ${account!.id} and fingerprint = any(${tx.array(prints)}::text[]) and month < ${faturaMonth}
        `;
      }
      const suspects = await flagSuspects(tx as unknown as Sql, insertedIds.slice(insertedIds.length - inserted), prints);
      await tx`update imports set inserted = ${inserted}, duplicates = ${duplicates} where id = ${imp!.id}`;

      summaries.push({
        importId: imp!.id,
        accountId: account!.id,
        accountName: account!.name,
        format,
        firstDate: dates[0],
        lastDate: dates.at(-1),
        total: rows.length,
        inserted,
        duplicates,
        suspects,
      });
    }

    // Descrição limpa e sugestão de categoria para o que acabou de entrar.
    if (insertedIds.length > 0) await categorize(tx as unknown as Sql, { onlyIds: insertedIds });
    return { fileName, previouslyImportedAt: previous?.created_at, statements: summaries, warnings };
  });
}

export interface TransactionRow {
  id: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  cleanDescription?: string;
  categoryName?: string;
  reviewed?: boolean;
  /** Mês de competência (AAAA-MM-01). No cartão, o mês de vencimento da fatura. */
  month?: string;
  accountKind?: "conta" | "cartao";
  billing?: boolean;
  accountName: string;
  installment?: string;
  cardLast4?: string;
}

/** Filtros de Lançamentos: mês de competência (AAAA-MM-01) e categoria (id ou "sem"). */
export interface TransactionFilter {
  month?: string;
  category?: number | "sem";
}

function filterSql(sql: Sql, f: TransactionFilter) {
  return sql`
    ${f.month ? sql`and t.month = ${f.month}::date` : sql``}
    ${f.category === "sem" ? sql`and t.category_id is null` : typeof f.category === "number" ? sql`and t.category_id = ${f.category}` : sql``}
  `;
}

export async function listTransactions(sql: Sql, { limit = 200, offset = 0, filter = {} as TransactionFilter } = {}): Promise<TransactionRow[]> {
  const rows = await sql<
    {
      id: string;
      date: string;
      amount: string;
      currency: string;
      description: string;
      account_name: string;
      installment_current: number | null;
      installment_total: number | null;
      card_last4: string | null;
      clean_description: string | null;
      category_name: string | null;
      reviewed: boolean;
      month: string;
      kind: "conta" | "cartao";
      source: string;
    }[]
  >`
    select t.id, to_char(t.date, 'YYYY-MM-DD') as date, t.amount, a.currency, t.description, a.name as account_name,
           t.installment_current, t.installment_total, t.card_last4, t.clean_description, c.name as category_name, t.reviewed,
           to_char(t.month, 'YYYY-MM-DD') as month, a.kind, a.source
    from transactions t join accounts a on a.id = t.account_id
    left join categories c on c.id = t.category_id
    where t.duplicate_of is null ${filterSql(sql, filter)}
    order by t.date desc, t.id desc
    limit ${limit} offset ${offset}
  `;
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: Number(r.amount),
    currency: r.currency,
    description: r.description,
    accountName: r.account_name,
    installment: r.installment_current ? `${r.installment_current}/${r.installment_total}` : undefined,
    cardLast4: r.card_last4 ?? undefined,
    cleanDescription: r.clean_description ?? undefined,
    categoryName: r.category_name ?? undefined,
    reviewed: r.reviewed,
    month: r.month,
    accountKind: r.kind,
    billing: r.source === "c6-fatura",
  }));
}

export async function countTransactions(sql: Sql, filter: TransactionFilter = {}): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*) as n from transactions t where t.duplicate_of is null ${filterSql(sql, filter)}`;
  return Number(row?.n ?? 0);
}
