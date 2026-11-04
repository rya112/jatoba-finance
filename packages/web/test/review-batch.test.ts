import { beforeEach, describe, expect, it } from "vitest";
import { CategoryError, type Category, type ReviewRow, type TransactionRow } from "@jatoba/core";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";
const CATEGORIES: Category[] = [
  { id: 1, name: "Mercado", kind: "despesa" },
  { id: 2, name: "Lazer", kind: "despesa" },
  { id: 3, name: "Pagamento de fatura", kind: "movimentacao" },
];
const row = (id: string, categoryId: number | null): ReviewRow => ({
  id, date: "2026-10-01", amount: -1000, currency: "BRL", description: `L${id}`, cleanDescription: `L${id}`,
  accountName: "Conta", accountKind: "conta", categoryId, categorySource: categoryId ? "regra" : null, rulePattern: categoryId ? "X" : null, bankCategory: null,
});

let calls: unknown[][];
let ai: { status: () => { enabled: boolean; reason?: string }; run: () => Promise<{ asked: number; suggested: number; unknown: number; inputTokens: number; outputTokens: number; skippedBatches: number }> } | undefined;
let lastFilter: unknown;

async function setup() {
  const empty = async () => [];
  const rows = [row("10", null), row("11", 3), row("12", null)];
  const tx: TransactionRow[] = [{ id: "1", date: "2026-10-01", amount: -100, currency: "BRL", description: "X", accountName: "Conta" }];
  const app = createApp({
    version: "teste",
    credentials: await Credentials.create(USER, PASSWORD),
    sessions: new MemorySessionStore(),
    limiter: new LoginLimiter(),
    checkDatabase: async () => true,
    clientKey: () => "teste",
    ledger: {
      importFile: async () => ({ fileName: "", statements: [], warnings: [] }),
      list: async (opts = {}) => {
        lastFilter = opts.filter;
        return tx;
      },
      count: async () => 1,
    },
    review: {
      categories: async () => CATEGORIES,
      list: async () => ({ rows, total: rows.length, withSuggestion: 1 }),
      setCategory: async (id, categoryId, opts = {}) => {
        if (opts.rulePattern !== undefined && opts.rulePattern.trim().length < 3) throw new CategoryError("O texto da regra precisa ter pelo menos 3 letras.");
        calls.push(["set", id, categoryId, opts]);
        return { otherChanged: opts.rulePattern ? 2 : 0, ruleCreated: opts.rulePattern !== undefined };
      },
      approve: async (ids) => {
        calls.push(["approve", ids]);
        return ids.length;
      },
      suspects: empty,
      resolve: async () => {},
    },
    month: { months: async () => ["2026-11-01", "2026-10-01", "2026-09-01"], summary: async () => { throw new Error("sem uso"); } },
    settings: { categories: empty, rules: empty, accounts: empty, createCategory: async () => 1, updateCategory: async () => {}, deleteCategory: async () => 0, createRule: async () => 0, updateRule: async () => 0, deleteRule: async () => 0, renameAccount: async () => {} },
    ai,
    backups: { status: async () => ({ configured: true, daily: true, hour: 3, keep: 14, count: 0 }), runNow: async () => "b" },
    transaction: { get: async () => undefined, reopen: async () => {} },
    subscriptions: { list: async () => ({ active: [], stopped: [], ignored: [], monthlyTotal: 0 }), ignore: async () => {}, unignore: async () => {} },
    goals: { today: () => "2026-11-04", list: empty, entries: empty, investments: empty, create: async () => 1, update: async () => {}, setArchived: async () => {}, delete: async () => {}, addEntry: async () => {}, deleteEntry: async () => {}, assign: async () => {} },
  });
  const res = await app.request("/entrar", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ usuario: USER, senha: PASSWORD }).toString(),
  });
  const cookie = `${SESSION_COOKIE}=${(res.headers.get("set-cookie") ?? "").match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, fields: [string, string][], origin = ORIGIN) =>
      app.request(path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }),
  };
}

/** O que o navegador envia: todos os campos da página, como estão. */
function pageFields(choices: Record<string, string>, extra: [string, string][] = []): [string, string][] {
  const fields: [string, string][] = [];
  for (const [id, suggestion] of [["10", ""], ["11", "3"], ["12", ""]] as const) {
    fields.push(["id", id], [`sugestao_${id}`, suggestion], [`categoria_${id}`, choices[id] ?? suggestion], [`regra_${id}`, `L${id}`]);
  }
  return [...fields, ...extra];
}

beforeEach(() => {
  calls = [];
  ai = undefined;
  lastFilter = undefined;
});

describe("Revisar: salvar vários de uma vez", () => {
  it("a página é um formulário só, com campos por lançamento", async () => {
    const { get } = await setup();
    const html = await (await get("/revisar")).text();
    expect(html).toContain('<form method="post" action="/revisar/lote">');
    expect(html).toContain('name="categoria_10"');
    expect(html).toContain('<button type="submit" name="so" value="11">Salvar</button>');
    expect(html).toContain('name="acao" value="todos"');
  });

  it("“Salvar todos”: grava os escolhidos; a sugestão sem mudança só é aprovada; sem escolha fica para depois", async () => {
    const { post, get } = await setup();
    const res = await post("/revisar/lote", pageFields({ "10": "2" }, [["acao", "todos"]]));
    expect(res.headers.get("location")).toBe("/revisar?lote=2&regras=0&outros=0");
    expect(calls).toEqual([["set", "10", 2, {}], ["approve", ["11"]]]);
    expect(await (await get("/revisar?lote=2&regras=0&outros=0")).text()).toContain("2 lançamento(s) salvo(s).");
  });

  it("“usar sempre” no lote cria a regra daquele lançamento", async () => {
    const { post } = await setup();
    const res = await post("/revisar/lote", pageFields({ "10": "1", "12": "2" }, [["criar_regra_12", "1"], ["acao", "todos"]]));
    expect(res.headers.get("location")).toBe("/revisar?lote=3&regras=1&outros=2");
    expect(calls).toEqual([["set", "10", 1, {}], ["set", "12", 2, { rulePattern: "L12" }], ["approve", ["11"]]]);
  });

  it("o “Salvar” de um cartão grava só aquele", async () => {
    const { post } = await setup();
    await post("/revisar/lote", pageFields({ "10": "2", "12": "1" }, [["so", "12"]]));
    expect(calls).toEqual([["set", "12", 1, {}]]);
  });

  it("“Salvar” de um cartão sem categoria pede uma", async () => {
    const { post } = await setup();
    const res = await post("/revisar/lote", pageFields({}, [["so", "10"]]));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("erro numa regra informa quantos já foram salvos", async () => {
    const { post } = await setup();
    const fields = pageFields({ "10": "1", "12": "2" }, [["criar_regra_12", "1"], ["acao", "todos"]]).map(([k, v]): [string, string] => (k === "regra_12" ? [k, "ab"] : [k, v]));
    const res = await post("/revisar/lote", fields);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("pelo menos 3 letras. (1 já foram salvos)");
  });

  it("ignora ids inválidos e envio de outro site", async () => {
    const { post } = await setup();
    await post("/revisar/lote", [["id", "1;drop"], ["categoria_1;drop", "1"], ["acao", "todos"]]);
    expect(calls).toEqual([]);
    expect((await post("/revisar/lote", pageFields({ "10": "2" }, [["acao", "todos"]]), "https://site-malicioso.example")).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("Lançamentos: faixa de meses", () => {
  it("mostra Todos e cada mês, com o atual destacado e o filtro de categoria mantido", async () => {
    const { get } = await setup();
    const all = await (await get("/lancamentos")).text();
    expect(all).toContain('<a class="chip" href="/lancamentos" aria-current="page">Todos</a>');
    expect(all).toContain('<a class="chip" href="/lancamentos?mes=2026-10">out/2026</a>');

    const oct = await (await get("/lancamentos?mes=2026-10&categoria=sem")).text();
    expect(oct).toContain('<a class="chip" href="/lancamentos?mes=2026-10&amp;categoria=sem" aria-current="page">out/2026</a>');
    expect(oct).toContain('<a class="chip" href="/lancamentos?categoria=sem">Todos</a>');
    expect(lastFilter).toEqual({ month: "2026-10-01", category: "sem" });
  });
});

describe("Revisar: sugerir com IA", () => {
  const result = { asked: 3, suggested: 5, unknown: 1, inputTokens: 100, outputTokens: 10, skippedBatches: 0 };

  it("sem IA configurada, não aparece o botão", async () => {
    const { get } = await setup();
    expect(await (await get("/revisar")).text()).not.toContain("Sugerir com IA");
  });

  it("com IA, o botão aparece, roda e informa o resultado", async () => {
    ai = { status: () => ({ enabled: true }), run: async () => { calls.push(["ai"]); return result; } };
    const { get, post } = await setup();
    const page = await (await get("/revisar")).text();
    expect(page).toContain("Sugerir com IA");
    expect(page).toContain("para os 2 sem sugestão");
    const res = await post("/revisar/ia", []);
    expect(res.headers.get("location")).toBe("/revisar?ia=5&ia_nao=1");
    expect(calls).toEqual([["ai"]]);
    expect(await (await get("/revisar?ia=5&ia_nao=1")).text()).toContain("A IA sugeriu categoria para 5 lançamento(s); em 1 estabelecimento(s) ela preferiu não chutar");
  });

  it("IA desligada por erro mostra o motivo; o botão não roda", async () => {
    ai = { status: () => ({ enabled: false, reason: "A chave da Anthropic foi recusada." }), run: async () => result };
    const { get, post } = await setup();
    expect(await (await get("/revisar")).text()).toContain("IA desligada: A chave da Anthropic foi recusada.");
    expect((await post("/revisar/ia", [])).status).toBe(400);
  });

  it("falha da API aparece na página", async () => {
    ai = { status: () => ({ enabled: true }), run: async () => { throw new Error("sem contato"); } };
    const { post } = await setup();
    const res = await post("/revisar/ia", []);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("A IA não respondeu: sem contato");
  });

  it("envio de outro site é bloqueado", async () => {
    ai = { status: () => ({ enabled: true }), run: async () => { calls.push(["ai"]); return result; } };
    const { post } = await setup();
    expect((await post("/revisar/ia", [], "https://site-malicioso.example")).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
