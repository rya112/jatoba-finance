/** Valores monetários sempre em centavos, como inteiros. */
export type Cents = number;

/**
 * Converte um valor textual em centavos.
 * Aceita o formato do OFX ("-123.45") e o brasileiro ("1.234,56").
 * Com mais de duas casas depois do último separador, ele é tratado
 * como separador de milhar ("1.234" = mil duzentos e trinta e quatro).
 */
export function toCents(raw: string): Cents {
  const value = raw.trim().replace(/\s/g, "");
  if (!/^[-+]?[\d.,]+$/.test(value) || !/\d/.test(value)) {
    throw new Error(`Valor inválido: "${raw}"`);
  }

  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[-+]/, "");
  const lastSeparator = Math.max(unsigned.lastIndexOf(","), unsigned.lastIndexOf("."));

  let integerPart = lastSeparator === -1 ? unsigned : unsigned.slice(0, lastSeparator);
  let fractionPart = lastSeparator === -1 ? "" : unsigned.slice(lastSeparator + 1);
  integerPart = integerPart.replace(/[.,]/g, "");

  if (fractionPart.length > 2) {
    integerPart += fractionPart;
    fractionPart = "";
  }

  const cents = Number(integerPart || "0") * 100 + Number((fractionPart + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Valor fora do limite: "${raw}"`);
  }
  return negative && cents !== 0 ? -cents : cents;
}

/** Formata centavos como moeda, por exemplo "R$ 1.234,56". */
export function formatMoney(cents: Cents, locale = "pt-BR", currency = "BRL"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
