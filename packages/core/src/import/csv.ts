import { toCents } from "../money.js";
import type { ImportResult, Statement, StatementKind, Transaction } from "./types.js";

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/** UTF-8 (com ou sem BOM) ou, se não for UTF-8 válido, Windows-1252, que é o padrão do Excel no Brasil. */
export function decodeText(bytes: Uint8Array): string {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Divide o CSV em linhas e colunas, com aspas ("a;b", "diz ""oi""") e quebras de linha dentro de aspas. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** "Valor (em R$)" → "valor (em r$)": sem acentos, minúsculo, espaços simples. */
export function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "03/10/2026", "3/10/2026", "2026-10-03" → "2026-10-03". */
export function parseDate(raw: string, format: "dd/mm/aaaa" | "aaaa-mm-dd"): string | undefined {
  const value = raw.trim();
  const m =
    format === "dd/mm/aaaa" ? value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/) : value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return undefined;
  const [y, mo, d] = format === "dd/mm/aaaa" ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return undefined;
  return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

/** "3/10", "03/10", "3 de 10", "Parcela 3/10" → {3, 10}. "Única", "-" ou vazio → sem parcela. */
export function parseInstallment(raw: string | undefined): { current: number; total: number } | undefined {
  const m = raw?.match(/(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})/i);
  if (!m) return undefined;
  const current = Number(m[1]);
  const total = Number(m[2]);
  if (current < 1 || total < 2 || current > total) return undefined;
  return { current, total };
}

/** Moeda no valor: "R$ 1.234,56", "US$ 10.00", "(12,34)" para negativo. */
function money(raw: string): number {
  let value = raw.trim().replace(/^(R\$|US\$|\$|€|£)\s*/i, "");
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  const cents = toCents(value.replace(/\s/g, ""));
  return negative ? -cents : cents;
}

/**
 * Como ler o CSV de um banco. Os nomes de colunas são comparados sem acento e sem maiúsculas.
 * Colunas opcionais que não existirem no arquivo são simplesmente ignoradas.
 */
export interface CsvLayout {
  id: string;
  name: string;
  kind: StatementKind;
  currency: string;
  delimiter: string;
  dateFormat: "dd/mm/aaaa" | "aaaa-mm-dd";
  /**
   * Convenção dos valores no arquivo:
   * - "saida_negativa": já está como o Jatobá usa;
   * - "saida_positiva": compras vêm positivas (comum em faturas) e são invertidas;
   * - "auto": decide pela maioria (numa fatura, a maioria das linhas é compra).
   */
  sign: "saida_negativa" | "saida_positiva" | "auto";
  columns: {
    date: string;
    description: string;
    amount: string;
    installment?: string;
    cardLast4?: string;
    holder?: string;
    bankCategory?: string;
    foreignAmount?: { column: string; currency: string };
    rate?: string;
  };
}

export const C6_FATURA: CsvLayout = {
  id: "c6-fatura",
  name: "Fatura do cartão C6 Bank (CSV)",
  kind: "cartao",
  currency: "BRL",
  delimiter: ";",
  dateFormat: "dd/mm/aaaa",
  sign: "auto",
  columns: {
    date: "Data de Compra",
    description: "Descrição",
    amount: "Valor (em R$)",
    installment: "Parcela",
    cardLast4: "Final do Cartão",
    holder: "Nome no Cartão",
    bankCategory: "Categoria",
    foreignAmount: { column: "Valor (em US$)", currency: "USD" },
    rate: "Cotação (em R$)",
  },
};

export const CSV_LAYOUTS: readonly CsvLayout[] = [C6_FATURA];

function headerIndex(header: string[], name: string): number {
  const wanted = normalizeHeader(name);
  return header.findIndex((h) => normalizeHeader(h) === wanted);
}

/** Qual layout combina com o cabeçalho do arquivo: todas as colunas obrigatórias precisam existir. */
export function detectLayout(text: string, layouts: readonly CsvLayout[] = CSV_LAYOUTS): CsvLayout | undefined {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return layouts.find((layout) => {
    const header = parseCsv(firstLine, layout.delimiter)[0] ?? [];
    const { date, description, amount } = layout.columns;
    return [date, description, amount].every((name) => headerIndex(header, name) !== -1);
  });
}

export function parseCsvStatement(input: Uint8Array | string, layout?: CsvLayout): ImportResult & { layout: CsvLayout; signInverted: boolean } {
  const text = typeof input === "string" ? input.replace(/^﻿/, "") : decodeText(input);
  const chosen = layout ?? detectLayout(text);
  if (!chosen) throw new CsvError("Não reconheci este CSV: o cabeçalho não bate com nenhum banco conhecido.");

  const [header = [], ...rows] = parseCsv(text, chosen.delimiter);
  const col = (name?: string) => (name ? headerIndex(header, name) : -1);
  const c = chosen.columns;
  const idx = {
    date: col(c.date),
    description: col(c.description),
    amount: col(c.amount),
    installment: col(c.installment),
    cardLast4: col(c.cardLast4),
    bankCategory: col(c.bankCategory),
    foreign: col(c.foreignAmount?.column),
    rate: col(c.rate),
  };
  for (const key of ["date", "description", "amount"] as const) {
    if (idx[key] === -1) throw new CsvError(`Coluna obrigatória não encontrada: "${c[key]}".`);
  }

  const warnings: string[] = [];
  const transactions: Transaction[] = [];
  const get = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

  for (const [n, row] of rows.entries()) {
    const line = n + 2; // linha 1 é o cabeçalho
    const date = parseDate(get(row, idx.date), chosen.dateFormat);
    if (!date) {
      warnings.push(`linha ${line}: data inválida; ignorada.`);
      continue;
    }
    let amount: number;
    try {
      amount = money(get(row, idx.amount));
    } catch {
      warnings.push(`linha ${line}: valor inválido; ignorada.`);
      continue;
    }

    const transaction: Transaction = { date, amount, type: "OTHER", description: get(row, idx.description).replace(/\s+/g, " ") };
    const installment = parseInstallment(get(row, idx.installment));
    if (installment) transaction.installment = installment;
    const card = get(row, idx.cardLast4).replace(/\D/g, "");
    if (card) transaction.cardLast4 = card.slice(-4);
    const category = get(row, idx.bankCategory);
    if (category && category !== "-") transaction.bankCategory = category;
    if (idx.foreign >= 0 && c.foreignAmount) {
      try {
        const foreign = money(get(row, idx.foreign));
        if (foreign !== 0) transaction.foreign = { amount: foreign, currency: c.foreignAmount.currency, rate: get(row, idx.rate) || undefined };
      } catch {
        // valor estrangeiro vazio ou ilegível: fica só o valor em reais
      }
    }
    transactions.push(transaction);
  }

  let invert = chosen.sign === "saida_positiva";
  if (chosen.sign === "auto") {
    const positives = transactions.filter((t) => t.amount > 0).length;
    const negatives = transactions.filter((t) => t.amount < 0).length;
    invert = positives > negatives;
  }
  if (invert) {
    for (const t of transactions) {
      t.amount = -t.amount || 0;
      if (t.foreign) t.foreign.amount = -t.foreign.amount || 0;
    }
  }

  const dates = transactions.map((t) => t.date).sort();
  const statement: Statement = {
    kind: chosen.kind,
    currency: chosen.currency,
    account: { accountId: chosen.id },
    start: dates[0],
    end: dates.at(-1),
    transactions,
  };
  return { statements: [statement], warnings, layout: chosen, signInverted: invert };
}
