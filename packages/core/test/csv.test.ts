import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  C6_FATURA,
  CsvError,
  decodeText,
  detectLayout,
  normalizeHeader,
  parseCsv,
  parseCsvStatement,
  parseDate,
  parseInstallment,
} from "../src/import/csv.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("fatura do C6 (CSV)", () => {
  const result = parseCsvStatement(fixture("c6-fatura-exemplo.csv"));
  const [fatura] = result.statements;
  const byDescription = (d: string) => fatura!.transactions.find((t) => t.description === d);

  it("reconhece o layout pelo cabeçalho, mesmo com BOM", () => {
    expect(result.layout.id).toBe("c6-fatura");
    expect(fatura!.kind).toBe("cartao");
  });

  it("compras viram saídas (negativas); pagamento e estorno viram entradas", () => {
    expect(result.signInverted).toBe(true);
    expect(byDescription("MERCADO EXEMPLO")!.amount).toBe(-31245);
    expect(byDescription("PAGAMENTO RECEBIDO")!.amount).toBe(234567);
    expect(byDescription("ESTORNO LOJA EXEMPLO")!.amount).toBe(5990);
  });

  it("lê data, parcela, cartão, categoria e milhar com ponto", () => {
    expect(byDescription("LOJA EXEMPLO")).toMatchObject({ date: "2026-10-08", installment: { current: 3, total: 10 }, cardLast4: "1111", bankCategory: "Departamento" });
    expect(byDescription("MERCADO EXEMPLO")!.installment).toBeUndefined();
    expect(byDescription("RESTAURANTE EXEMPLO")!.cardLast4).toBe("2222");
    expect(byDescription("HOTEL EXEMPLO; CENTRO")!.amount).toBe(-145000);
    expect(byDescription("PAGAMENTO RECEBIDO")!.bankCategory).toBeUndefined();
  });

  it("guarda o valor em dólar e a cotação da compra internacional", () => {
    expect(byDescription("STREAMING EXEMPLO")).toMatchObject({ amount: -4490, foreign: { amount: -799, currency: "USD", rate: "5,62" } });
    expect(byDescription("MERCADO EXEMPLO")!.foreign).toBeUndefined();
  });

  it("ignora a linha com data impossível e avisa, sem mostrar o conteúdo", () => {
    expect(fatura!.transactions).toHaveLength(7);
    expect(result.warnings).toEqual(["linha 9: data inválida; ignorada."]);
  });

  it("o período vem das datas dos lançamentos", () => {
    expect(fatura!.start).toBe("2026-10-05");
    expect(fatura!.end).toBe("2026-10-22");
  });
});

describe("sinal dos valores", () => {
  const header = "Data de Compra;Nome no Cartão;Final do Cartão;Categoria;Descrição;Parcela;Valor (em US$);Cotação (em R$);Valor (em R$)";

  it("no modo auto, não inverte se as compras já vierem negativas", () => {
    const csv = `${header}\n01/10/2026;A;1;X;COMPRA 1;;0;0;-10,00\n02/10/2026;A;1;X;COMPRA 2;;0;0;-20,00\n03/10/2026;A;1;X;PAGAMENTO;;0;0;30,00`;
    const result = parseCsvStatement(csv);
    expect(result.signInverted).toBe(false);
    expect(result.statements[0]!.transactions.map((t) => t.amount)).toEqual([-1000, -2000, 3000]);
  });

  it("um layout com sinal fixo respeita a configuração", () => {
    const csv = `${header}\n01/10/2026;A;1;X;PAGAMENTO;;0;0;30,00`;
    expect(parseCsvStatement(csv, { ...C6_FATURA, sign: "saida_negativa" }).statements[0]!.transactions[0]!.amount).toBe(3000);
  });
});

describe("CSV desconhecido", () => {
  it("recusa com mensagem clara", () => {
    expect(() => parseCsvStatement("Data,Valor,Historico\n01/10/2026,10.00,X")).toThrow(CsvError);
    expect(detectLayout("Data,Valor,Historico")).toBeUndefined();
  });
});

describe("partes do leitor", () => {
  it("parseCsv lida com aspas, aspas escapadas, quebra de linha dentro de aspas e linhas vazias", () => {
    expect(parseCsv('a;"b;c";"diz ""oi"""\r\n\r\n"linha\nquebrada";2\n', ";")).toEqual([
      ["a", "b;c", 'diz "oi"'],
      ["linha\nquebrada", "2"],
    ]);
  });

  it("decodeText: UTF-8 com BOM, UTF-8 sem BOM e Windows-1252", () => {
    expect(decodeText(Buffer.from("﻿Descrição", "utf8"))).toBe("Descrição");
    expect(decodeText(Buffer.from("Descrição", "utf8"))).toBe("Descrição");
    expect(decodeText(Buffer.from("Descrição", "latin1"))).toBe("Descrição");
  });

  it("normalizeHeader ignora acento, caixa e espaços extras", () => {
    expect(normalizeHeader("  Cotação   (em R$) ")).toBe("cotacao (em r$)");
  });

  it("parseDate valida a data", () => {
    expect(parseDate("3/1/2026", "dd/mm/aaaa")).toBe("2026-01-03");
    expect(parseDate("31/02/2026", "dd/mm/aaaa")).toBeUndefined();
    expect(parseDate("2026-10-03", "aaaa-mm-dd")).toBe("2026-10-03");
  });

  it("parseInstallment aceita os formatos comuns e recusa os impossíveis", () => {
    expect(parseInstallment("3/10")).toEqual({ current: 3, total: 10 });
    expect(parseInstallment("03/10")).toEqual({ current: 3, total: 10 });
    expect(parseInstallment("Parcela 2 de 6")).toEqual({ current: 2, total: 6 });
    expect(parseInstallment("Única")).toBeUndefined();
    expect(parseInstallment("")).toBeUndefined();
    expect(parseInstallment("11/10")).toBeUndefined();
  });
});
