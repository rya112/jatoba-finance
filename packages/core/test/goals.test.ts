import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Sql } from "../src/db.js";
import {
  addGoalEntry,
  assignTransaction,
  computeProgress,
  createGoal,
  deleteGoal,
  deleteGoalEntry,
  listGoalEntries,
  listGoals,
  listUnassignedInvestments,
  parseAmount,
  parseDeadline,
  setGoalArchived,
  updateGoal,
} from "../src/goals.js";
import { importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const TODAY = "2026-11-03";

describe("parseAmount e parseDeadline", () => {
  it("aceita os formatos que as pessoas digitam", () => {
    expect(parseAmount("10000")).toBe(1_000_000);
    expect(parseAmount("10.000")).toBe(1_000_000);
    expect(parseAmount("R$ 10.000,50")).toBe(1_000_050);
    expect(parseAmount("2500,5")).toBe(250_050);
    expect(() => parseAmount("0")).toThrow(/maior que zero/);
    expect(() => parseAmount("dez mil")).toThrow(/Valor inválido/);
    expect(parseDeadline("2027-12")).toBe("2027-12-01");
    expect(parseDeadline("")).toBeUndefined();
    expect(() => parseDeadline("2027-13")).toThrow(/Prazo/);
  });
});

describe("computeProgress", () => {
  const viagem = { id: 1, name: "Viagem", target: 1_000_000, archived: false };

  it("com prazo: quanto por mês e se está no ritmo", () => {
    // Faltam R$ 7.000 até dez/2027: 14 meses contando novembro → R$ 500/mês.
    const p = computeProgress({ ...viagem, deadline: "2027-12-01" }, 300_000, 3 * 60_000, TODAY);
    expect(p).toMatchObject({ saved: 300_000, remaining: 700_000, percent: 30, monthsLeft: 14, monthlyNeeded: 50_000, monthlyPace: 60_000, status: "no-ritmo" });
    const slow = computeProgress({ ...viagem, deadline: "2027-12-01" }, 300_000, 3 * 20_000, TODAY);
    expect(slow.status).toBe("abaixo");
  });

  it("sem prazo: em quantos meses chega no ritmo atual", () => {
    expect(computeProgress(viagem, 400_000, 3 * 100_000, TODAY)).toMatchObject({ status: "sem-prazo", monthsAtPace: 6 });
    expect(computeProgress(viagem, 400_000, 0, TODAY).status).toBe("sem-historico");
  });

  it("atingida, acima do alvo e prazo vencido", () => {
    expect(computeProgress(viagem, 1_200_000, 0, TODAY)).toMatchObject({ status: "atingida", remaining: 0, percent: 100 });
    expect(computeProgress({ ...viagem, deadline: "2026-10-01" }, 100, 0, TODAY)).toMatchObject({ status: "prazo-vencido", monthsLeft: 0 });
    expect(computeProgress({ ...viagem, deadline: "2026-11-01" }, 0, 0, TODAY)).toMatchObject({ monthsLeft: 1, monthlyNeeded: 1_000_000 });
  });

  it("retiradas maiores que o guardado não deixam a barra negativa", () => {
    expect(computeProgress(viagem, -5000, 0, TODAY).percent).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("metas no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await freshDatabase("goals");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  beforeEach(async () => {
    await sql`truncate goal_entries, goals, transactions, imports, accounts restart identity cascade`;
    // O extrato fictício tem "APLICACAO CDB EXEMPLO" (aporte de R$ 1.500).
    await importFile(sql, "conta.ofx", fixture("banco-exemplo-corrente.ofx"));
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("cria a meta com o que já está guardado, e o saldo inicial não conta no ritmo", async () => {
    const id = await createGoal(sql, { name: " Viagem ", target: "10000", deadline: "2027-12", saved: "3.000" }, TODAY);
    const [goal] = await listGoals(sql, TODAY);
    expect(goal).toMatchObject({ id, name: "Viagem", target: 1_000_000, saved: 300_000, deadline: "2027-12-01", monthlyPace: 0, status: "abaixo" });
    const [entry] = await listGoalEntries(sql, id);
    expect(entry).toMatchObject({ amount: 300_000, initial: true });
  });

  it("guardar e retirar mudam o progresso e o ritmo; apagar o registro desfaz", async () => {
    const id = await createGoal(sql, { name: "Reserva", target: "6000", deadline: "", saved: "" }, TODAY);
    await addGoalEntry(sql, id, { kind: "guardar", amount: "900", date: "2026-10-10", note: " CDB " });
    await addGoalEntry(sql, id, { kind: "retirar", amount: "300", date: "2026-11-01", note: "" });
    let [goal] = await listGoals(sql, TODAY);
    expect(goal).toMatchObject({ saved: 60_000, monthlyPace: 20_000, status: "sem-prazo", monthsAtPace: 27 });

    const entries = await listGoalEntries(sql, id);
    expect(entries.map((e) => [e.amount, e.note])).toEqual([[-30_000, null], [90_000, "CDB"]]);
    await deleteGoalEntry(sql, entries[0]!.id);
    [goal] = await listGoals(sql, TODAY);
    expect(goal!.saved).toBe(90_000);
  });

  it("guardado há mais de 3 meses conta no total, mas não no ritmo", async () => {
    const id = await createGoal(sql, { name: "Reserva", target: "6000", deadline: "", saved: "" }, TODAY);
    await addGoalEntry(sql, id, { kind: "guardar", amount: "900", date: "2026-07-31", note: "" });
    const [goal] = await listGoals(sql, TODAY);
    expect(goal).toMatchObject({ saved: 90_000, monthlyPace: 0 });
  });

  it("aporte do extrato: aparece sem meta, liga uma vez só, e conta como guardado", async () => {
    const id = await createGoal(sql, { name: "Viagem", target: "10000", deadline: "", saved: "" }, TODAY);
    const [aporte] = await listUnassignedInvestments(sql);
    expect(aporte).toMatchObject({ amount: -150_000, categoryName: "Aporte em investimento" });

    await assignTransaction(sql, aporte!.id, id);
    expect(await listUnassignedInvestments(sql)).toEqual([]);
    expect((await listGoals(sql, TODAY))[0]!.saved).toBe(150_000);
    await expect(assignTransaction(sql, aporte!.id, id)).rejects.toThrow(/já está ligado/);

    const [entry] = await listGoalEntries(sql, id);
    expect(entry).toMatchObject({ transactionId: aporte!.id, description: "APLICACAO CDB EXEMPLO" });
    await deleteGoalEntry(sql, entry!.id); // desligar
    expect(await listUnassignedInvestments(sql)).toHaveLength(1);
  });

  it("resgate ligado à meta conta como retirada", async () => {
    const id = await createGoal(sql, { name: "Viagem", target: "10000", deadline: "", saved: "2000" }, TODAY);
    const [resgate] = await sql`
      insert into transactions (account_id, import_id, fingerprint, date, month, amount, description, type, category_id)
      select 1, 1, 'h:resgate', '2026-11-02', '2026-11-01', 50000, 'RESGATE CDB', 'CREDIT', id from categories where name = 'Resgate de investimento'
      returning id`;
    await assignTransaction(sql, resgate!.id, id);
    expect((await listGoals(sql, TODAY))[0]!.saved).toBe(200_000 - 50_000);
  });

  it("edita, arquiva, desarquiva e apaga", async () => {
    const id = await createGoal(sql, { name: "Viagem", target: "10000", deadline: "", saved: "100" }, TODAY);
    await updateGoal(sql, id, { name: "Viagem ao Chile", target: "12.000", deadline: "2027-06" });
    expect((await listGoals(sql, TODAY))[0]).toMatchObject({ name: "Viagem ao Chile", target: 1_200_000, deadline: "2027-06-01" });

    await setGoalArchived(sql, id, true);
    expect(await listGoals(sql, TODAY)).toEqual([]);
    expect(await listGoals(sql, TODAY, { archived: true })).toHaveLength(1);
    await setGoalArchived(sql, id, false);

    await deleteGoal(sql, id);
    expect(await listGoals(sql, TODAY)).toEqual([]);
    const [left] = await sql`select count(*)::int as n from goal_entries`;
    expect(left!.n).toBe(0);
    const [tx] = await sql`select count(*)::int as n from transactions`;
    expect(tx!.n).toBe(7); // os lançamentos do extrato continuam
  });

  it("recusa entradas inválidas", async () => {
    const id = await createGoal(sql, { name: "Viagem", target: "10000", deadline: "", saved: "" }, TODAY);
    await expect(createGoal(sql, { name: "x", target: "10", deadline: "", saved: "" }, TODAY)).rejects.toThrow(/2 a 60/);
    await expect(addGoalEntry(sql, id, { kind: "doar", amount: "10", date: TODAY, note: "" })).rejects.toThrow(/guardar ou retirar/);
    await expect(addGoalEntry(sql, id, { kind: "guardar", amount: "10", date: "03/11/2026", note: "" })).rejects.toThrow(/Data/);
    await expect(addGoalEntry(sql, 999, { kind: "guardar", amount: "10", date: TODAY, note: "" })).rejects.toThrow(/não encontrada/);
    await expect(assignTransaction(sql, "1", 999)).rejects.toThrow(/não encontrada/);
  });
});
