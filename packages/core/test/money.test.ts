import { describe, expect, it } from "vitest";
import { formatMoney, toCents } from "../src/money.js";

describe("toCents", () => {
  it.each([
    ["-123.45", -12345],
    ["123,45", 12345],
    ["1.234,56", 123456],
    ["1,234.56", 123456],
    ["10.5", 1050],
    ["0,99", 99],
    ["1.234", 123400],
    ["  2345.67 ", 234567],
    ["-0.00", 0],
    ["+59.90", 5990],
  ])("converte %s em %i centavos", (raw, expected) => {
    expect(toCents(raw)).toBe(expected);
  });

  it.each(["", "abc", "12a", "-", "R$ 10"])("rejeita %j", (raw) => {
    expect(() => toCents(raw)).toThrow();
  });
});

describe("formatMoney", () => {
  it("formata em reais", () => {
    expect(formatMoney(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
  });

  it("formata valores negativos", () => {
    expect(formatMoney(-5990).replace(/\s/g, " ")).toBe("-R$ 59,90");
  });
});

describe("moedas sem centavos", () => {
  it("peso chileno usa 0 casas; real e dólar, 2", async () => {
    const { currencyDigits } = await import("../src/money.js");
    expect(currencyDigits("CLP")).toBe(0);
    expect(currencyDigits("BRL")).toBe(2);
    expect(currencyDigits("USD")).toBe(2);
    expect(formatMoney(15000, "pt-BR", "CLP")).toContain("15.000");
    expect(formatMoney(15000, "pt-BR", "CLP")).not.toContain(",");
  });
});
