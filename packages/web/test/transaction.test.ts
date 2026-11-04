import { beforeEach, describe, expect, it } from "vitest";
import { CategoryError, type Category, type TransactionDetail } from "@jatoba/core";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";
const CATEGORIES: Category[] = [
  { id: 1, name: "Mercado", kind: "despesa" },
  { id: 2, name: "Outros", kind: "despesa" },
];

let tx: TransactionDetail;
let calls: unknown[][];

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
    review: {
      categories: async () => CATEGORIES,
      list: async () => ({ rows: [], total: 0, withSuggestion: 0 }),
      setCategory: async (id, categoryId, opts = {}) => {
        if (opts.rulePattern !== undefined && opts.rulePattern.length < 3) throw new CategoryError("O texto da regra precisa ter pelo menos 3 letras.");
        calls.push(["setCategory", id, categoryId, opts]);
        return { otherChanged: opts.rulePattern ? 3 : 0, ruleCreated: opts.rulePattern !== undefined };
      },
      approve: async () => 0,
      suspects: empty,
      resolve: async () => {},
    },
    month: { months: empty, summary: async () => { throw new Error("sem meses"); } },
    settings: { categories: empty, rules: empty, accounts: empty, createCategory: async () => 1, updateCategory: async () => {}, deleteCategory: async () => 0, createRule: async () => 0, updateRule: async () => 0, deleteRule: async () => 0, renameAccount: async () => {} },
    transaction: {
      get: async (id) => (id === tx.id ? tx : undefined),
      reopen: async (id) => void calls.push(["reopen", id]),
    },
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
    app,
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, fields: [string, string][], origin = ORIGIN) =>
      app.request(path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }),
  };
}

beforeEach(() => {
  calls = [];
  tx = {
    id: "42", date: "2026-10-14", month: "2026-11-01", amount: -4490, currency: "BRL",
    description: "STREAMING <b>X</b> 001", cleanDescription: "STREAMING <b>X</b>", type: "OTHER",
    accountId: 2, accountName: "Cartão C6", accountKind: "cartao", billing: true, installment: undefined,
    cardLast4: "3333", bankCategory: "TV por assinatura", foreign: { amount: -799, currency: "USD", rate: "5.62" },
    categoryId: 1, categoryName: "Mercado", categorySource: "manual", rulePattern: null, reviewed: true,
    fileName: "c6-202611-fatura.csv", importedAt: new Date("2026-11-03T12:00:00Z"), duplicateOf: null, suspectOf: null, goalName: null,
  };
});

describe("página de um lançamento", () => {
  it("exige login", async () => {
    const { app } = await setup();
    expect((await app.request("/lancamentos/42")).status).toBe(303);
  });

  it("mostra os detalhes, escapados, e permite editar e voltar para revisão", async () => {
    const { get } = await setup();
    const html = (await (await get("/lancamentos/42")).text()).replace(/\s/g, " ");
    expect(html).toContain("<h1>STREAMING &#60;b&#62;X&#60;/b&#62;</h1>");
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("novembro de 2026 (vencimento da fatura)");
    expect(html).toContain("cartão final 3333");
    expect(html).toContain("US$ 7,99");
    expect(html).toContain("cotação 5.62");
    expect(html).toContain("escolhida por você · revisado");
    expect(html).toContain('<option value="1" selected>Mercado</option>');
    expect(html).toContain("Voltar para revisão");
    expect(html).toContain('href="/lancamentos?mes=2026-11"');
  });

  it("troca a categoria, com ou sem regra", async () => {
    const { post, get } = await setup();
    const res = await post("/lancamentos/42", [["categoria", "2"], ["regra", "STREAMING"]]);
    expect(res.headers.get("location")).toBe("/lancamentos/42?ok=salvo&outros=0");
    const withRule = await post("/lancamentos/42", [["categoria", "2"], ["criar_regra", "1"], ["regra", "STREAMING"]]);
    expect(withRule.headers.get("location")).toBe("/lancamentos/42?ok=regra&outros=3");
    expect(calls).toEqual([["setCategory", "42", 2, {}], ["setCategory", "42", 2, { rulePattern: "STREAMING" }]]);
    expect(await (await get("/lancamentos/42?ok=regra&outros=3")).text()).toContain("3 outro(s) lançamento(s) ganharam sugestão");
  });

  it("voltar para revisão", async () => {
    const { post } = await setup();
    const res = await post("/lancamentos/42/revisar", []);
    expect(res.headers.get("location")).toBe("/lancamentos/42?ok=revisar");
    expect(calls).toEqual([["reopen", "42"]]);
  });

  it("cópia de duplicado não pode ser editada", async () => {
    tx.duplicateOf = "41";
    const { get } = await setup();
    const html = await (await get("/lancamentos/42")).text();
    expect(html).toContain("marcado como <strong>cópia</strong>");
    expect(html).not.toContain('action="/lancamentos/42"');
  });

  it("erros e recusas", async () => {
    const { get, post } = await setup();
    expect((await get("/lancamentos/999")).status).toBe(404);
    expect((await get("/lancamentos/abc")).status).toBe(404);
    expect((await post("/lancamentos/42", [["categoria", ""]])).status).toBe(400);
    const short = await post("/lancamentos/42", [["categoria", "2"], ["criar_regra", "1"], ["regra", "ab"]]);
    expect(short.status).toBe(400);
    expect(await short.text()).toContain("pelo menos 3 letras");
    expect((await post("/lancamentos/999/revisar", [])).status).toBe(404);
    expect((await post("/lancamentos/42", [["categoria", "2"]], "https://site-malicioso.example")).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
