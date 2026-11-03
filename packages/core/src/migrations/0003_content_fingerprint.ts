import { createHash } from "node:crypto";
import type postgres from "postgres";

/**
 * 0003: duplicados passam a ser reconhecidos pelo conteúdo, não pelo FITID.
 *
 * Motivo: o C6 gera FITIDs novos a cada exportação, então o mesmo lançamento,
 * exportado em dois períodos que se sobrepõem, entrava duas vezes.
 *
 * O que faz, numa única transação:
 * 1. recalcula a impressão digital dos lançamentos que usavam o FITID ("fitid:..."),
 *    com a mesma regra que o CSV já usava (data, valor, descrição, cartão, parcela
 *    e número da ocorrência no arquivo);
 * 2. apaga as cópias repetidas, mantendo sempre a primeira importada;
 * 3. corrige as contagens de novos e repetidos de cada importação.
 *
 * A lógica fica congelada aqui de propósito: migrações publicadas não mudam.
 */

function normalizeDescription(value: string): string {
  return value.normalize("NFC").toUpperCase().replace(/\s+/g, " ").trim();
}

function fingerprint(base: string, occurrence: number): string {
  return `h:${createHash("sha256").update(base).digest("hex").slice(0, 32)}#${occurrence}`;
}

interface Row {
  id: string;
  import_id: number;
  date: string;
  amount: string;
  description: string;
  card_last4: string | null;
  installment_current: number | null;
  installment_total: number | null;
}

export const contentFingerprint = {
  id: "0003_content_fingerprint",
  sql: `alter table transactions drop constraint transactions_account_id_fingerprint_key;`,
  run: async (tx: postgres.TransactionSql) => {
    const rows = await tx<Row[]>`
      select id, import_id, to_char(date, 'YYYY-MM-DD') as date, amount, description,
             card_last4, installment_current, installment_total
      from transactions
      where fingerprint like 'fitid:%'
      order by import_id, id
    `;

    // Número da ocorrência dentro do mesmo arquivo, na ordem em que os lançamentos foram gravados.
    const seen = new Map<string, number>();
    const updates: { id: string; fingerprint: string }[] = [];
    for (const r of rows) {
      const base = [
        r.date,
        Number(r.amount),
        normalizeDescription(r.description),
        r.card_last4 ?? "",
        r.installment_current ? `${r.installment_current}/${r.installment_total}` : "",
      ].join("|");
      const key = `${r.import_id}|${base}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      updates.push({ id: r.id, fingerprint: fingerprint(base, occurrence) });
    }

    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      await tx`
        update transactions t set fingerprint = u.fingerprint
        from (select unnest(${tx.array(chunk.map((u) => u.id))}::bigint[]) as id,
                     unnest(${tx.array(chunk.map((u) => u.fingerprint))}::text[]) as fingerprint) u
        where t.id = u.id
      `;
    }

    // Apaga as cópias, mantendo a primeira, e devolve quantas saíram de cada importação.
    const removed = await tx<{ import_id: number; n: string }[]>`
      with ranked as (
        select id, import_id, row_number() over (partition by account_id, fingerprint order by id) as copy
        from transactions
      ), gone as (
        delete from transactions t using ranked r where t.id = r.id and r.copy > 1
        returning t.import_id
      )
      select import_id, count(*) as n from gone group by import_id
    `;
    for (const r of removed) {
      await tx`
        update imports set inserted = inserted - ${Number(r.n)}, duplicates = duplicates + ${Number(r.n)}
        where id = ${r.import_id}
      `;
    }

    await tx`alter table transactions add constraint transactions_account_fingerprint_key unique (account_id, fingerprint)`;
  },
};
