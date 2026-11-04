import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Sql } from "../src/db.js";
import { importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import {
  detectSubscriptions,
  ignoreSubscription,
  listSubscriptions,
  merchantKey,
  nextMonthSameDay,
  unignoreSubscription,
  type SubscriptionCharge,
} from "../src/subscriptions.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const TODAY = "2026-11-03";
const charge = (date: string, amount: number, description: string, categoryName: string | null = null): SubscriptionCharge => ({ date, amount, description, categoryName });

describe("merchantKey", () => {
  it("ignora números, códigos, pontuação e prefixos de banco", () => {
    expect(merchantKey("NETFLIX.COM 0123*45")).toBe("NETFLIX COM");
    expect(merchantKey("Netflix.com 9876*12")).toBe("NETFLIX COM");
    expect(merchantKey("COMPRA CARTAO DEBITO ACADEMIA EXEMPLO 10/2026")).toBe("ACADEMIA EXEMPLO");
  });
});

describe("nextMonthSameDay", () => {
  it("mesmo dia do mês seguinte, ou o último dia se não existir", () => {
    expect(nextMonthSameDay("2026-10-14")).toBe("2026-11-14");
    expect(nextMonthSameDay("2026-12-05")).toBe("2027-01-05");
    expect(nextMonthSameDay("2026-10-31")).toBe("2026-11-30");
    expect(nextMonthSameDay("2027-01-31")).toBe("2027-02-28");
  });
});

describe("detectSubscriptions", () => {
  it("encontra a cobrança mensal e prevê a próxima", () => {
    const [s, ...rest] = detectSubscriptions(
      [charge("2026-09-14", 3990, "STREAMING EXEMPLO 001", "Assinaturas"), charge("2026-10-14", 3990, "STREAMING EXEMPLO 002", "Assinaturas")],
      TODAY,
    );
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ key: "STREAMING EXEMPLO", lastAmount: 3990, charges: 2, firstDate: "2026-09-14", lastDate: "2026-10-14", nextDate: "2026-11-14", active: true, categoryName: "Assinaturas" });
    expect(s!.previousAmount).toBeUndefined();
  });

  it("avisa reajuste de preço", () => {
    const [s] = detectSubscriptions([charge("2026-08-10", 4990, "ACADEMIA"), charge("2026-09-10", 4990, "ACADEMIA"), charge("2026-10-10", 5490, "ACADEMIA")], TODAY);
    expect(s).toMatchObject({ lastAmount: 5490, previousAmount: 4990, charges: 3 });
  });

  it("sem cobrança há mais de 45 dias: parou", () => {
    const [s] = detectSubscriptions([charge("2026-07-05", 2000, "REVISTA"), charge("2026-08-05", 2000, "REVISTA")], TODAY);
    expect(s!.active).toBe(false);
  });

  it("não confunde com gasto frequente, valores muito diferentes nem intervalos que não são mensais", () => {
    const uber = ["2026-10-01", "2026-10-03", "2026-10-08", "2026-10-20", "2026-11-01"].map((d) => charge(d, 2500, "UBER TRIP"));
    const mercado = [charge("2026-09-05", 12000, "MERCADO X"), charge("2026-10-05", 35000, "MERCADO X")];
    const semanal = [charge("2026-10-01", 1000, "FEIRA"), charge("2026-10-08", 1000, "FEIRA"), charge("2026-10-15", 1000, "FEIRA")];
    const anual = [charge("2025-10-01", 9900, "DOMINIO"), charge("2026-10-01", 9900, "DOMINIO")];
    const unica = [charge("2026-10-01", 9900, "LOJA")];
    expect(detectSubscriptions([...uber, ...mercado, ...semanal, ...anual, ...unica], TODAY)).toEqual([]);
  });

  it("tolera uma cobrança fora do padrão no meio", () => {
    const list = [
      charge("2026-07-10", 3000, "SERVICO"),
      charge("2026-08-10", 3000, "SERVICO"),
      charge("2026-08-20", 300, "SERVICO"), // taxa avulsa
      charge("2026-09-10", 3000, "SERVICO"),
      charge("2026-10-10", 3000, "SERVICO"),
    ];
    expect(detectSubscriptions(list, TODAY)[0]).toMatchObject({ charges: 4, lastAmount: 3000 });
  });

  it("ativas primeiro, depois pelo valor", () => {
    const list = [
      charge("2026-09-01", 1000, "BARATA"), charge("2026-10-01", 1000, "BARATA"),
      charge("2026-09-02", 9000, "CARA"), charge("2026-10-02", 9000, "CARA"),
      charge("2026-06-01", 50000, "ANTIGA"), charge("2026-07-01", 50000, "ANTIGA"),
    ];
    expect(detectSubscriptions(list, TODAY).map((s) => s.key)).toEqual(["CARA", "BARATA", "ANTIGA"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("assinaturas no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("subscriptions");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
    // O cartão fictício tem STREAMING EXEMPLO em 14/09 e 14/10, e parcelas da LOJA EXEMPLO (que não contam).
    await importFile(sql, "cartao.ofx", readFileSync(new URL("./fixtures/cartao-exemplo.ofx", import.meta.url)));
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("encontra o streaming e ignora as parcelas", async () => {
    const list = await listSubscriptions(sql, TODAY);
    expect(list.active.map((s) => [s.key, s.lastAmount, s.nextDate])).toEqual([["STREAMING EXEMPLO", 3990, "2026-11-14"]]);
    expect(list.monthlyTotal).toBe(3990);
    expect(list.stopped).toEqual([]);
  });

  it("“não é assinatura” tira da lista, e dá para desfazer", async () => {
    await ignoreSubscription(sql, "STREAMING EXEMPLO", "Streaming exemplo");
    let list = await listSubscriptions(sql, TODAY);
    expect(list.active).toEqual([]);
    expect(list.ignored).toEqual([{ key: "STREAMING EXEMPLO", name: "Streaming exemplo" }]);
    await unignoreSubscription(sql, "STREAMING EXEMPLO");
    list = await listSubscriptions(sql, TODAY);
    expect(list.active).toHaveLength(1);
  });
});

describe("conta com extrato ainda não importado", () => {
  const list = [
    { date: "2026-08-01", amount: 9900, description: "ACADEMIA", categoryName: null, account: "Conta" },
    { date: "2026-09-01", amount: 9900, description: "ACADEMIA", categoryName: null, account: "Conta" },
    { date: "2026-10-01", amount: 9900, description: "ACADEMIA", categoryName: null, account: "Conta" },
  ];

  it("sem informação do último dia importado: conta a partir de hoje (atrasada)", () => {
    expect(detectSubscriptions(list, TODAY)[0]).toMatchObject({ active: true, late: true });
  });

  it("extrato só até 31/10: não é atrasada; a cobrança de novembro ainda não foi importada", () => {
    expect(detectSubscriptions(list, TODAY, { Conta: "2026-10-31" })[0]).toMatchObject({ active: true, late: false, nextDate: "2026-11-01" });
  });

  it("muito tempo sem importar não faz parecer que parou", () => {
    expect(detectSubscriptions(list, "2027-03-01", { Conta: "2026-10-20" })[0]!.active).toBe(true);
    expect(detectSubscriptions(list, "2027-03-01", { Conta: "2027-02-28" })[0]!.active).toBe(false);
  });
});

describe("assinatura em mais de uma conta", () => {
  it("detecta por conta: o mesmo serviço no cartão e na conta não vira “frequente demais”", () => {
    const found = detectSubscriptions(
      [
        { date: "2026-09-14", amount: 3990, description: "STREAMING", categoryName: null, account: "Cartão" },
        { date: "2026-10-14", amount: 3990, description: "STREAMING", categoryName: null, account: "Cartão" },
        { date: "2026-10-14", amount: 4490, description: "STREAMING", categoryName: null, account: "Conta" },
      ],
      TODAY,
    );
    expect(found.map((s) => [s.key, s.accountName, s.charges])).toEqual([["STREAMING", "Cartão", 2]]);
  });
});
