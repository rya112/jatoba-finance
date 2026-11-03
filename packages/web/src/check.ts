import {
  decodeText,
  detectLayout,
  normalizeHeader,
  parseCsv,
  parseCsvStatement,
  parseOfx,
  CsvError,
  type Statement,
} from "@jatoba/core";

/**
 * Resumo de um extrato para conferir arquivos reais sem expor dados:
 * nunca imprime descrições, valores, nomes nem números completos de conta ou cartão.
 */

/** "-1.234,56" → "-9.999,99". Mostra o formato sem o valor. */
export function shape(value: string): string {
  return value.trim().replace(/\d/g, "9") || "(vazio)";
}

function countShapes(values: string[], max = 6): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(shape(v), (counts.get(shape(v)) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, max).map(([s, n]) => `"${s}" ${n}`);
  if (sorted.length > max) shown.push(`e mais ${sorted.length - max} formato(s)`);
  return shown.join(", ");
}

function statementLines(s: Statement, index: number): string[] {
  const ids = s.transactions.map((t) => t.externalId);
  const missing = ids.filter((id) => !id).length;
  const repeated = ids.length - missing - new Set(ids.filter(Boolean)).size;
  const types = Object.entries(Object.groupBy(s.transactions, (t) => t.type))
    .map(([type, list]) => `${type} ${list!.length}`)
    .join(", ");
  const dates = s.transactions.map((t) => t.date).sort();
  const outflows = s.transactions.filter((t) => t.amount < 0).length;
  const lines = [
    `Extrato ${index + 1}: ${s.kind === "conta" ? "conta corrente" : "cartão de crédito"}, moeda ${s.currency}` +
      (/\d{3,}/.test(s.account.accountId) ? `, conta final ${s.account.accountId.slice(-4)}` : ""),
    `  período informado: ${s.start ?? "?"} a ${s.end ?? "?"}; lançamentos de ${dates[0] ?? "-"} a ${dates.at(-1) ?? "-"}`,
    `  lançamentos: ${s.transactions.length} (${types || "nenhum"}); saídas ${outflows}, entradas ${s.transactions.length - outflows}`,
    `  descrições vazias: ${s.transactions.filter((t) => !t.description).length}; saldo informado: ${s.ledgerBalance ? "sim" : "não"}`,
  ];
  if (ids.some(Boolean)) lines.push(`  FITID: ${missing} sem, ${repeated} repetido(s)`);
  const installments = s.transactions.filter((t) => t.installment).length;
  const foreign = s.transactions.filter((t) => t.foreign).length;
  const cards = new Set(s.transactions.map((t) => t.cardLast4).filter(Boolean)).size;
  const categories = new Set(s.transactions.map((t) => t.bankCategory).filter(Boolean)).size;
  if (installments || foreign || cards || categories) {
    lines.push(`  parceladas: ${installments}; em moeda estrangeira: ${foreign}; cartões diferentes: ${cards}; categorias do banco: ${categories}`);
  }
  return lines;
}

export function checkFile(bytes: Uint8Array): string[] {
  const text = decodeText(bytes);
  const out: string[] = [];

  if (/<OFX>/i.test(text)) {
    const { statements, warnings } = parseOfx(bytes);
    out.push(`Formato: OFX. ${statements.length} extrato(s). Nada foi importado nem gravado.`, "");
    statements.forEach((s, i) => out.push(...statementLines(s, i)));
    out.push("", ...(warnings.length ? ["Avisos:", ...warnings.map((w) => `  - ${w}`)] : ["Sem avisos."]));
    return out;
  }

  const layout = detectLayout(text);
  if (!layout) {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    const delimiter = [";", ",", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
    const columns = (parseCsv(firstLine, delimiter)[0] ?? []).length;
    throw new CsvError(
      `Não reconheci este arquivo. Se for CSV, o cabeçalho não bate com nenhum banco conhecido ` +
        `(${columns} coluna(s), separador "${delimiter === "\t" ? "tab" : delimiter}"). ` +
        "Mande só a primeira linha do arquivo, a dos nomes das colunas.",
    );
  }

  const result = parseCsvStatement(bytes, layout);
  out.push(`Formato: CSV, ${layout.name}. Nada foi importado nem gravado.`, "");
  result.statements.forEach((s, i) => out.push(...statementLines(s, i)));

  // Formatos das colunas, com os dígitos trocados por 9, para conferir as convenções do banco.
  const [header = [], ...rows] = parseCsv(text, layout.delimiter);
  const column = (name?: string) => (name ? header.findIndex((h) => normalizeHeader(h) === normalizeHeader(name)) : -1);
  const values = (name?: string) => {
    const i = column(name);
    return i === -1 ? [] : rows.map((r) => r[i] ?? "");
  };
  out.push("", "Formatos encontrados (dígitos trocados por 9, sem valores):");
  out.push(`  data: ${countShapes(values(layout.columns.date))}`);
  out.push(`  valor: ${countShapes(values(layout.columns.amount))}`);
  if (layout.columns.installment) out.push(`  parcela: ${countShapes(values(layout.columns.installment))}`);
  if (layout.columns.foreignAmount) out.push(`  valor estrangeiro: ${countShapes(values(layout.columns.foreignAmount.column))}`);
  out.push(
    `  sinal: ${result.signInverted ? "compras vinham positivas e foram invertidas" : "valores mantidos como vieram"}`,
  );
  out.push("", ...(result.warnings.length ? ["Avisos:", ...result.warnings.map((w) => `  - ${w}`)] : ["Sem avisos."]));
  return out;
}
