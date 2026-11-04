import { toCents, type Cents } from "../money.js";
import type { ImportResult, Statement, StatementKind, Transaction } from "./types.js";

/**
 * Leitor de OFX tolerante: aceita OFX 1.x (SGML, tags de valor sem fechamento)
 * e OFX 2.x (XML), em Windows-1252 ou UTF-8, com extratos de conta e de cartão.
 * Não grava nada: só transforma o arquivo em dados.
 */

export type OfxTransaction = Transaction;
export type OfxStatement = Statement;
export type OfxResult = ImportResult;

export class OfxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfxError";
  }
}

interface OfxNode {
  name: string;
  value?: string;
  children: OfxNode[];
}

/** Descobre a codificação pelo cabeçalho e decodifica. Sem pista, tenta UTF-8 e cai para Windows-1252. */
export function decodeOfx(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const xmlEncoding = head.match(/<\?xml[^>]*encoding=["']([^"']+)["']/i)?.[1];
  const charset = head.match(/^CHARSET:\s*(\S+)/im)?.[1];
  const encoding = head.match(/^ENCODING:\s*(\S+)/im)?.[1];

  let label: string | undefined;
  if (xmlEncoding) label = xmlEncoding;
  else if (encoding && /utf-?8/i.test(encoding)) label = "utf-8";
  else if (charset && /^(1252|windows-1252|cp1252)$/i.test(charset)) label = "windows-1252";
  else if (charset && /^(8859-1|iso-8859-1|latin-?1)$/i.test(charset)) label = "iso-8859-1";

  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // rótulo desconhecido: segue para a detecção
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** Monta a árvore. Tag com texto é valor; tag sem texto é grupo, fechado pelo seu </TAG> ou pelo do pai. */
function parseTree(text: string): OfxNode {
  const start = text.search(/<OFX>/i);
  if (start === -1) throw new OfxError("O arquivo não parece um OFX (não encontrei a tag <OFX>).");

  const root: OfxNode = { name: "ROOT", children: [] };
  const stack: OfxNode[] = [root];
  let lastLeaf: OfxNode | undefined;
  const tag = /<(\/?)([A-Za-z0-9_.]+)[^>]*>([^<]*)/g;

  for (const match of text.slice(start).matchAll(tag)) {
    const closing = match[1] === "/";
    const name = match[2]!.toUpperCase();
    const value = decodeEntities(match[3]!).trim();
    const current = stack[stack.length - 1]!;

    if (closing) {
      if (lastLeaf?.name === name) {
        lastLeaf = undefined; // fechamento de valor do OFX 2.x: <CODE>0</CODE>
        continue;
      }
      const index = stack.map((n) => n.name).lastIndexOf(name);
      if (index > 0) stack.length = index; // fecha este grupo e qualquer grupo esquecido dentro dele
      lastLeaf = undefined;
      continue;
    }

    if (value !== "") {
      lastLeaf = { name, value, children: [] };
      current.children.push(lastLeaf);
    } else {
      const group: OfxNode = { name, children: [] };
      current.children.push(group);
      stack.push(group);
      lastLeaf = undefined;
    }
  }
  return root;
}

function findAll(node: OfxNode, name: string, out: OfxNode[] = []): OfxNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

function find(node: OfxNode | undefined, name: string): OfxNode | undefined {
  return node ? findAll(node, name)[0] : undefined;
}

/** Valor de um filho direto (não procura em grupos aninhados). */
function field(node: OfxNode | undefined, name: string): string | undefined {
  return node?.children.find((c) => c.name === name && c.value !== undefined)?.value;
}

/** "20261005", "20261005120000", "20261005120000.000[-3:BRT]" → "2026-10-05". */
export function ofxDate(raw: string | undefined): string | undefined {
  const m = raw?.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return undefined;
  return `${y}-${mo}-${d}`;
}

/**
 * Parcela escrita no texto, como "LOJA PARC 03/10" ou "PARCELA 3 DE 10". Exige a palavra PARC,
 * para não confundir com datas. Devolve undefined se não houver ou se for impossível.
 */
export function installmentFromText(text: string): { current: number; total: number } | undefined {
  const m = text.toUpperCase().match(/\bPARC(?:ELA)?\.?\s*(\d{1,3})\s*(?:\/|DE)\s*(\d{1,3})\b/);
  if (!m) return undefined;
  const current = Number(m[1]);
  const total = Number(m[2]);
  return current >= 1 && total >= 2 && current <= total ? { current, total } : undefined;
}

function joinDescription(name?: string, memo?: string): string {
  const parts = [name, memo].map((p) => p?.replace(/\s+/g, " ").trim()).filter((p): p is string => !!p);
  if (parts.length === 2 && (parts[0]!.includes(parts[1]!) || parts[1]!.includes(parts[0]!))) {
    return parts[0]!.length >= parts[1]!.length ? parts[0]! : parts[1]!;
  }
  return parts.join(" - ");
}

function readStatement(node: OfxNode, kind: StatementKind, warnings: string[]): OfxStatement {
  const accountNode = find(node, kind === "conta" ? "BANKACCTFROM" : "CCACCTFROM");
  const accountId = field(accountNode, "ACCTID");
  if (!accountId) throw new OfxError("Extrato sem identificação da conta (ACCTID).");

  const list = find(node, "BANKTRANLIST");
  const transactions: OfxTransaction[] = [];
  for (const [index, trn] of findAll(node, "STMTTRN").entries()) {
    const date = ofxDate(field(trn, "DTPOSTED") ?? field(trn, "DTUSER"));
    const rawAmount = field(trn, "TRNAMT");
    const where = `lançamento ${index + 1}${field(trn, "FITID") ? ` (FITID ${field(trn, "FITID")})` : ""}`;
    if (!date) {
      warnings.push(`${where}: sem data válida; ignorado.`);
      continue;
    }
    let amount: Cents;
    try {
      amount = toCents(rawAmount ?? "");
    } catch {
      warnings.push(`${where}: valor inválido (${rawAmount ?? "vazio"}); ignorado.`);
      continue;
    }
    const name = field(trn, "NAME") ?? field(find(trn, "PAYEE"), "NAME");
    const memo = field(trn, "MEMO");
    const description = joinDescription(name, memo);
    const installment = installmentFromText(description);
    transactions.push({
      externalId: field(trn, "FITID"),
      date,
      amount,
      type: (field(trn, "TRNTYPE") ?? "OTHER").toUpperCase(),
      description,
      ...(installment ? { installment } : {}),
      name,
      memo,
      checkNumber: field(trn, "CHECKNUM"),
    });
  }

  const ledger = find(node, "LEDGERBAL");
  let ledgerBalance: OfxStatement["ledgerBalance"];
  const balanceRaw = field(ledger, "BALAMT");
  if (balanceRaw) {
    try {
      ledgerBalance = { amount: toCents(balanceRaw), date: ofxDate(field(ledger, "DTASOF")) };
    } catch {
      warnings.push(`saldo inválido (${balanceRaw}); ignorado.`);
    }
  }

  return {
    kind,
    currency: (field(node, "CURDEF") ?? "BRL").toUpperCase(),
    account: {
      bankId: field(accountNode, "BANKID"),
      branchId: field(accountNode, "BRANCHID"),
      accountId,
      accountType: field(accountNode, "ACCTTYPE"),
    },
    start: ofxDate(field(list, "DTSTART")),
    end: ofxDate(field(list, "DTEND")),
    ledgerBalance,
    transactions,
  };
}

export function parseOfx(input: Uint8Array | string): OfxResult {
  const text = typeof input === "string" ? input : decodeOfx(input);
  const tree = parseTree(text);
  const warnings: string[] = [];

  const signon = find(tree, "SONRS");
  const code = field(find(signon, "STATUS"), "CODE");
  if (code && code !== "0") {
    const message = field(find(signon, "STATUS"), "MESSAGE");
    throw new OfxError(`O banco gerou o arquivo com erro (código ${code}${message ? `: ${message}` : ""}).`);
  }

  const statements = [
    ...findAll(tree, "STMTRS").map((n) => readStatement(n, "conta", warnings)),
    ...findAll(tree, "CCSTMTRS").map((n) => readStatement(n, "cartao", warnings)),
  ];
  if (statements.length === 0) throw new OfxError("O OFX não tem nenhum extrato de conta ou de cartão.");
  return { statements, warnings };
}
