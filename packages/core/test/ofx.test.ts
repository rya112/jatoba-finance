import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OfxError, decodeOfx, ofxDate, parseOfx } from "../src/import/ofx.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe("parseOfx: extratos fictícios do projeto", () => {
  it("lê a conta corrente com todos os lançamentos e o saldo", () => {
    const { statements, warnings } = parseOfx(fixture("banco-exemplo-corrente.ofx"));
    expect(warnings).toEqual([]);
    expect(statements).toHaveLength(1);
    const [conta] = statements;
    expect(conta!.kind).toBe("conta");
    expect(conta!.currency).toBe("BRL");
    expect(conta!.transactions).toHaveLength(7);
    expect(conta!.transactions[0]).toMatchObject({
      date: "2026-10-05",
      amount: 850000,
      type: "CREDIT",
      externalId: "CC20261005001",
      description: "CREDITO SALARIO EMPRESA EXEMPLO LTDA",
    });
    const fatura = conta!.transactions.find((t) => t.description.startsWith("PAGAMENTO FATURA"));
    expect(fatura?.amount).toBe(-234567);
  });

  it("lê o cartão: parcelas, estorno e pagamento recebido", () => {
    const [cartao] = parseOfx(fixture("cartao-exemplo.ofx")).statements;
    expect(cartao!.kind).toBe("cartao");
    expect(cartao!.transactions).toHaveLength(8);
    expect(cartao!.transactions.map((t) => t.description)).toContain("LOJA EXEMPLO PARC 03/10");
    expect(cartao!.transactions.find((t) => t.description === "ESTORNO LOJA EXEMPLO")?.amount).toBe(5990);
    expect(cartao!.start).toBe("2026-09-01");
    expect(cartao!.end).toBe("2026-10-31");
  });

  it("FITIDs são únicos em cada extrato fictício", () => {
    for (const name of ["banco-exemplo-corrente.ofx", "cartao-exemplo.ofx", "ofx2-xml-utf8.ofx", "sgml-1252-conta-e-cartao.ofx"]) {
      const ids = parseOfx(fixture(name)).statements.flatMap((s) => s.transactions.map((t) => t.externalId));
      expect(new Set(ids).size, name).toBe(ids.length);
    }
  });
});

describe("parseOfx: OFX 2 (XML, UTF-8)", () => {
  const { statements, warnings } = parseOfx(fixture("ofx2-xml-utf8.ofx"));
  const [conta] = statements;

  it("lê a conta e os acentos em UTF-8", () => {
    expect(warnings).toEqual([]);
    expect(conta!.account).toEqual({ bankId: "999", branchId: "0001", accountId: "12345-6", accountType: "CHECKING" });
    expect(conta!.transactions[0]!.description).toBe("PADARIA SÃO JOÃO - Compra no débito");
  });

  it("lê o nome dentro de PAYEE e decodifica &amp;", () => {
    expect(conta!.transactions[1]!.description).toBe("LOJA A & B EXEMPLO");
  });

  it("não repete NAME e MEMO iguais", () => {
    expect(conta!.transactions[2]!.description).toBe("PIX RECEBIDO");
  });

  it("lê o saldo", () => {
    expect(conta!.ledgerBalance).toEqual({ amount: 116150, date: "2026-10-31" });
  });
});

describe("parseOfx: OFX 1 (SGML, Windows-1252), conta e cartão no mesmo arquivo", () => {
  const { statements, warnings } = parseOfx(fixture("sgml-1252-conta-e-cartao.ofx"));
  const [conta, cartao] = statements;

  it("separa os dois extratos", () => {
    expect(statements.map((s) => s.kind)).toEqual(["conta", "cartao"]);
    expect(cartao!.account.accountId).toBe("5555XXXXXXXX0000");
    expect(cartao!.transactions[0]!.description).toBe("FARMÁCIA EXEMPLO");
  });

  it("acentos em Windows-1252, vírgula decimal e data com hora e fuso", () => {
    expect(conta!.transactions[0]).toMatchObject({ date: "2026-10-03", amount: -4590, description: "AÇOUGUE BOA CARNE" });
    expect(conta!.transactions[1]).toMatchObject({ amount: -123456, description: "ALUGUEL OUTUBRO" });
    expect(conta!.ledgerBalance?.amount).toBe(50000);
  });

  it("ignora o lançamento sem data e avisa", () => {
    expect(conta!.transactions).toHaveLength(2);
    expect(warnings).toEqual(["lançamento 3 (FITID S3): sem data válida; ignorado."]);
  });
});

describe("parseOfx: erros", () => {
  it("recusa arquivo que não é OFX", () => {
    expect(() => parseOfx("Data,Valor\n01/10/2026,10.00")).toThrow(OfxError);
  });

  it("recusa OFX sem extrato", () => {
    expect(() => parseOfx("<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</STATUS></SONRS></SIGNONMSGSRSV1></OFX>")).toThrow(/nenhum extrato/);
  });

  it("informa erro gerado pelo banco", () => {
    expect(() => parseOfx("<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>15500<SEVERITY>ERROR<MESSAGE>Sessão expirada</STATUS></SONRS></SIGNONMSGSRSV1></OFX>")).toThrow(
      /código 15500: Sessão expirada/,
    );
  });

  it("avisa sobre valor inválido sem derrubar o resto", () => {
    const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><ACCTID>1</BANKACCTFROM><BANKTRANLIST>
      <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>abc<FITID>A</STMTTRN>
      <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>-5.00<FITID>B</STMTTRN>
      </BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const { statements, warnings } = parseOfx(ofx);
    expect(statements[0]!.transactions.map((t) => t.externalId)).toEqual(["B"]);
    expect(warnings[0]).toMatch(/FITID A.*valor inválido/);
  });
});

describe("ofxDate", () => {
  it("aceita as variações e recusa datas impossíveis", () => {
    expect(ofxDate("20261005")).toBe("2026-10-05");
    expect(ofxDate("20261005235959.999[-3:BRT]")).toBe("2026-10-05");
    expect(ofxDate("20260230")).toBeUndefined();
    expect(ofxDate("2026")).toBeUndefined();
    expect(ofxDate(undefined)).toBeUndefined();
  });
});

describe("decodeOfx", () => {
  it("sem cabeçalho, reconhece UTF-8 e cai para Windows-1252", () => {
    expect(decodeOfx(Buffer.from("<OFX>São", "utf8"))).toBe("<OFX>São");
    expect(decodeOfx(Buffer.from("<OFX>São", "latin1"))).toBe("<OFX>São");
  });
});

describe("parcela no texto do OFX", () => {
  it("reconhece PARC e PARCELA, e não confunde com datas", async () => {
    const { installmentFromText } = await import("../src/import/ofx.js");
    expect(installmentFromText("LOJA EXEMPLO PARC 03/10")).toEqual({ current: 3, total: 10 });
    expect(installmentFromText("LOJA PARCELA 2 DE 6")).toEqual({ current: 2, total: 6 });
    expect(installmentFromText("Loja parc.4/12")).toEqual({ current: 4, total: 12 });
    expect(installmentFromText("PAGAMENTO 03/10")).toBeUndefined();
    expect(installmentFromText("PARC 11/10")).toBeUndefined();
  });

  it("o cartão fictício passa a ter as parcelas da LOJA EXEMPLO", () => {
    const [cartao] = parseOfx(fixture("cartao-exemplo.ofx")).statements;
    expect(cartao!.transactions.filter((t) => t.installment).map((t) => t.installment)).toEqual([
      { current: 3, total: 10 },
      { current: 4, total: 10 },
    ]);
  });
});
