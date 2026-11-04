import { beforeEach, describe, expect, it } from "vitest";
import { GoalError, computeProgress, type GoalEntry, type GoalProgress, type InvestmentTransaction } from "@jatoba/core";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";
const TODAY = "2026-11-03";

function memoryGoals() {
  const goals: GoalProgress[] = [
    computeProgress({ id: 1, name: "Viagem <b>Chile</b>", target: 1_000_000, deadline: "2027-12-01", archived: false }, 300_000, 3 * 60_000, TODAY),
    computeProgress({ id: 2, name: "Reserva", target: 2_000_000, archived: false }, 500_000, 0, TODAY),
  ];
  const archived: GoalProgress[] = [computeProgress({ id: 3, name: "Notebook", target: 500_000, archived: true }, 500_000, 0, TODAY)];
  const entries: Record<number, GoalEntry[]> = {
    1: [
      { id: "50", date: "2026-10-10", amount: 90_000, note: "CDB", initial: false, transactionId: null, description: null },
      { id: "51", date: "2026-10-12", amount: 150_000, note: null, initial: false, transactionId: "700", description: "APLICACAO CDB" },
    ],
  };
  const investments: InvestmentTransaction[] = [{ id: "701", date: "2026-11-01", amount: -50_000, description: "APLICACAO CDB", categoryName: "Aporte em investimento", accountName: "Conta" }];
  const calls: unknown[][] = [];
  const check = (cond: boolean, msg: string) => {
    if (!cond) throw new GoalError(msg);
  };
  return {
    calls,
    today: () => TODAY,
    list: async (opts: { archived?: boolean } = {}) => (opts.archived ? archived : goals),
    entries: async (id: number) => entries[id] ?? [],
    investments: async () => investments,
    create: async (input: { name: string; target: string; deadline: string; saved: string }) => {
      check(input.target !== "", "Valor inválido.");
      calls.push(["create", input]);
      return 9;
    },
    update: async (id: number, input: unknown) => void calls.push(["update", id, input]),
    setArchived: async (id: number, a: boolean) => void calls.push(["setArchived", id, a]),
    delete: async (id: number) => void calls.push(["delete", id]),
    addEntry: async (id: number, input: { kind: string; amount: string; date: string; note: string }) => {
      check(input.kind === "guardar" || input.kind === "retirar", "Escolha guardar ou retirar.");
      calls.push(["addEntry", id, input]);
    },
    deleteEntry: async (id: string) => void calls.push(["deleteEntry", id]),
    assign: async (tx: string, goal: number) => void calls.push(["assign", tx, goal]),
  };
}

let goals: ReturnType<typeof memoryGoals>;

async function setup() {
  const empty = async () => [];
  const app = createApp({
    version: "teste",
    credentials: await Credentials.create(USER, PASSWORD),
    sessions: new MemorySessionStore(),
    limiter: new LoginLimiter(),
    checkDatabase: async () => true,
    clientKey: () => "teste",
    ledger: { importFile: async () => ({ fileName: "", statements: [], warnings: [] }), list: empty, count: async () => 0 },
    review: { categories: empty, list: async () => ({ rows: [], total: 0, withSuggestion: 0 }), setCategory: async () => ({ otherChanged: 0, ruleCreated: false }), approve: async () => 0, suspects: empty, resolve: async () => {} },
    month: { months: empty, summary: async () => { throw new Error("sem meses"); } },
    settings: { categories: empty, rules: empty, accounts: empty, createCategory: async () => 1, updateCategory: async () => {}, deleteCategory: async () => 0, createRule: async () => 0, updateRule: async () => 0, deleteRule: async () => 0, renameAccount: async () => {} },
    transaction: { get: async () => undefined, reopen: async () => {} },
    subscriptions: { list: async () => ({ active: [], stopped: [], ignored: [], monthlyTotal: 0 }), ignore: async () => {}, unignore: async () => {} },
    goals,
  });
  const res = await app.request("/entrar", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ usuario: USER, senha: PASSWORD }).toString(),
  });
  const cookie = `${SESSION_COOKIE}=${(res.headers.get("set-cookie") ?? "").match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
  return {
    app,
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, fields: [string, string][], origin = ORIGIN) =>
      app.request(path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }),
  };
}

beforeEach(() => {
  goals = memoryGoals();
});

describe("Metas", () => {
  it("exige login", async () => {
    const { app } = await setup();
    expect((await app.request("/metas")).status).toBe(303);
  });

  it("mostra progresso, ritmo, histórico, arquivadas e aportes sem meta; tudo escapado", async () => {
    const { get } = await setup();
    const html = (await (await get("/metas")).text()).replace(/\s/g, " ");
    expect(html).toContain("Viagem &#60;b&#62;Chile&#60;/b&#62;");
    expect(html).not.toContain("<b>Chile</b>");
    expect(html).toContain("<strong>R$ 3.000,00</strong> <span class=\"suave\">de R$ 10.000,00</span>");
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain("30% · faltam R$ 7.000,00 · prazo: dezembro de 2027");
    expect(html).toContain("No ritmo:</span> guardar R$ 500,00 por mês até dezembro de 2027");
    expect(html).toContain("Sem prazo e sem nada guardado nos últimos 3 meses.");
    expect(html).toContain("extrato: APLICACAO CDB");
    expect(html).toContain(">desligar</button>");
    expect(html).toContain("Notebook");
    expect(html).toContain("Reativar");
    expect(html).toContain('action="/metas/ligar/701"');
    expect(html).toContain('value="2026-11-03"');
    expect(html).toContain('href="/metas" aria-current="page"');
  });

  it("cria, edita, registra, liga, arquiva e apaga", async () => {
    const { post } = await setup();
    const created = await post("/metas", [["nome", "Viagem"], ["alvo", "10000"], ["prazo", ""], ["guardado", ""]]);
    expect(created.headers.get("location")).toBe("/metas?ok=criada");
    await post("/metas/1", [["nome", "Viagem"], ["alvo", "12.000"], ["prazo", "2027-06"]]);
    await post("/metas/1/registros", [["tipo", "guardar"], ["valor", "500"], ["data", TODAY], ["nota", "CDB"]]);
    await post("/metas/ligar/701", [["meta", "1"]]);
    await post("/metas/registros/50/apagar", []);
    await post("/metas/2/arquivar", [["arquivar", "1"]]);
    await post("/metas/3/arquivar", [["arquivar", "0"]]);
    await post("/metas/2/apagar", [["confirmar", "1"]]);
    expect(goals.calls).toEqual([
      ["create", { name: "Viagem", target: "10000", deadline: "", saved: "" }],
      ["update", 1, { name: "Viagem", target: "12.000", deadline: "2027-06" }],
      ["addEntry", 1, { kind: "guardar", amount: "500", date: TODAY, note: "CDB" }],
      ["assign", "701", 1],
      ["deleteEntry", "50"],
      ["setArchived", 2, true],
      ["setArchived", 3, false],
      ["delete", 2],
    ]);
  });

  it("mensagens de sucesso e de erro", async () => {
    const { get, post } = await setup();
    expect(await (await get("/metas?ok=registrado")).text()).toContain("Registrado.");
    const bad = await post("/metas/1/registros", [["tipo", "doar"], ["valor", "500"], ["data", TODAY], ["nota", ""]]);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Escolha guardar ou retirar.");
  });

  it("apagar exige confirmação; ids inválidos e outro site são recusados", async () => {
    const { post } = await setup();
    const res = await post("/metas/2/apagar", []);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Marque a confirmação");
    expect((await post("/metas/ligar/701", [["meta", "x"]])).status).toBe(400);
    expect((await post("/metas/abc/registros", [["tipo", "guardar"], ["valor", "1"], ["data", TODAY], ["nota", ""]])).status).toBe(400);
    expect((await post("/metas", [["nome", "Viagem"], ["alvo", "10000"]], "https://site-malicioso.example")).status).toBe(403);
    expect(goals.calls).toEqual([]);
  });
});
