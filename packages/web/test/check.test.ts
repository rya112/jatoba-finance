import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CsvError, parseCsvStatement, parseOfx } from "@jatoba/core";
import { checkFile, shape } from "../src/check.js";

const fixture = (name: string) => readFileSync(new URL(`../../core/test/fixtures/${name}`, import.meta.url));

/** Tudo o que não pode aparecer na saída: descrições, valores, nomes e números completos. */
function secrets(name: string): string[] {
  const bytes = fixture(name);
  const statements = name.endsWith(".csv") ? parseCsvStatement(bytes).statements : parseOfx(bytes).statements;
  const out: string[] = [];
  for (const s of statements) {
    if (/\d{5,}/.test(s.account.accountId)) out.push(s.account.accountId);
    for (const t of s.transactions) {
      out.push(t.description);
      const abs = Math.abs(t.amount);
      out.push(`${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`, `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`);
    }
  }
  return out.filter((s) => s.length >= 4);
}

describe("jatoba check não expõe dados", () => {
  for (const name of ["c6-fatura-exemplo.csv", "banco-exemplo-corrente.ofx", "cartao-exemplo.ofx", "sgml-1252-conta-e-cartao.ofx", "ofx2-xml-utf8.ofx"]) {
    it(name, () => {
      const output = checkFile(fixture(name)).join("\n");
      for (const secret of secrets(name)) expect(output, `vazou: ${secret}`).not.toContain(secret);
      expect(output).not.toMatch(/TITULAR|ADICIONAL/);
    });
  }
});

describe("jatoba check: conteúdo do resumo", () => {
  it("mostra as convenções da fatura do C6 só como formatos", () => {
    const output = checkFile(fixture("c6-fatura-exemplo.csv")).join("\n");
    expect(output).toContain("Fatura do cartão C6 Bank");
    expect(output).toContain('parcela: "Única" 9, "9/99" 1');
    expect(output).toContain("compras vinham positivas e foram invertidas");
    expect(output).toContain("cartões diferentes: 3");
    expect(output).not.toContain("conta final");
  });

  it("mostra o final da conta só para números de conta reais", () => {
    expect(checkFile(fixture("cartao-exemplo.ofx")).join("\n")).toContain("conta final 0000");
  });

  it("CSV desconhecido: explica e descreve só o cabeçalho", () => {
    expect(() => checkFile(Buffer.from("Data;Valor;Histórico\n01/10/2026;10,00;SEGREDO"))).toThrow(CsvError);
    expect(() => checkFile(Buffer.from("Data;Valor;Histórico\n01/10/2026;10,00;SEGREDO"))).toThrow(/3 coluna\(s\), separador ";"/);
  });

  it("shape troca dígitos por 9", () => {
    expect(shape("-1.234,56")).toBe("-9.999,99");
    expect(shape("  ")).toBe("(vazio)");
  });
});
