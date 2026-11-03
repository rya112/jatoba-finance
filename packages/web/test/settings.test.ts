import { beforeEach, describe, expect, it } from "vitest";
import { CategoryError, type AccountInfo, type CategoryUsage, type RuleDetail, type RuleInput } from "@jatoba/core";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";

/** Ajustes em memória, com as mesmas validações essenciais do banco. */
function memorySettings() {
  const categories: CategoryUsage[] = [
    { id: 1, name: "Mercado", kind: "despesa", transactions: 22, rules: 0 },
    { id: 2, name: "Outros <i>x</i>", kind: "despesa", transactions: 0, rules: 0 },
    { id: 3, name: "Salário", kind: "receita", transactions: 3, rules: 1 },
    { id: 4, name: "Pagamento de fatura", kind: "movimentacao", transactions: 4, rules: 2 },
  ];
  const rules: RuleDetail[] = [
    { id: 10, pattern: "PADARIA", direction: "saida", accountKind: "conta", categoryId: 1, categoryName: "Mercado", origin: "usuario", matches: 5 },
    { id: 11, pattern: "FATURA", direction: "saida", accountKind: "conta", categoryId: 4, categoryName: "Pagamento de fatura", origin: "sistema", matches: 4 },
  ];
  const accounts: AccountInfo[] = [{ id: 1, name: "Conta final 8554", kind: "conta", currency: "BRL", last4: "8554", transactions: 362 }];
  const calls: unknown[][] = [];
  return {
    calls,
    async categories() {
      return categories;
    },
    async rules() {
      return rules;
    },
    async accounts() {
      return accounts;
    },
    async createCategory(input: { name: string; kind: string }) {
      if (input.name.trim().length < 2) throw new CategoryError("O nome precisa ter de 2 a 40 caracteres.");
      calls.push(["createCategory", input]);
      return 99;
    },
    async updateCategory(id: number, input: { name: string; kind: string }) {
      calls.push(["updateCategory", id, input]);
    },
    async deleteCategory(id: number, opts: { moveTo?: number }) {
      if (opts.moveTo === id) throw new CategoryError("Escolha outra categoria para receber os lançamentos.");
      calls.push(["deleteCategory", id, opts]);
      return 22;
    },
    async createRule(input: RuleInput) {
      if (input.pattern.trim().length < 3) throw new CategoryError("O texto da regra precisa ter pelo menos 3 letras.");
      calls.push(["createRule", input]);
      return 7;
    },
    async updateRule(id: number, input: RuleInput) {
      calls.push(["updateRule", id, input]);
      return 2;
    },
    async deleteRule(id: number) {
      calls.push(["deleteRule", id]);
      return 5;
    },
    async renameAccount(id: number, name: string) {
      calls.push(["renameAccount", id, name]);
    },
  };
}

let settings: ReturnType<typeof memorySettings>;

async function makeApp() {
  const empty = async () => [];
  return createApp({
    version: "teste",
    credentials: await Credentials.create(USER, PASSWORD),
    sessions: new MemorySessionStore(),
    limiter: new LoginLimiter(),
    checkDatabase: async () => true,
    clientKey: () => "teste",
    ledger: { importFile: async () => ({ fileName: "", statements: [], warnings: [] }), list: empty, count: async () => 0 },
    review: {
      categories: empty,
      list: async () => ({ rows: [], total: 0, withSuggestion: 0 }),
      setCategory: async () => ({ otherChanged: 0, ruleCreated: false }),
      approve: async () => 0,
      suspects: empty,
      resolve: async () => {},
    },
    month: { months: empty, summary: async () => { throw new Error("sem meses"); } },
    settings,
  });
}

async function loggedIn() {
  const app = await makeApp();
  const res = await app.request("/entrar", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ usuario: USER, senha: PASSWORD }).toString(),
  });
  const cookie = `${SESSION_COOKIE}=${(res.headers.get("set-cookie") ?? "").match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
  const post = (path: string, fields: [string, string][], origin = ORIGIN) =>
    app.request(path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  const get = (path: string) => app.request(path, { headers: { Cookie: cookie } });
  return { app, post, get };
}

beforeEach(() => {
  settings = memorySettings();
});

describe("Ajustes", () => {
  it("exige login", async () => {
    const app = await makeApp();
    expect((await app.request("/ajustes")).status).toBe(303);
    expect((await app.request("/ajustes/categorias", { method: "POST", headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it("mostra categorias por grupo, regras com origem e uso, e contas; tudo escapado", async () => {
    const { get } = await loggedIn();
    const html = await (await get("/ajustes")).text();
    expect(html).toContain("<strong>Mercado</strong>");
    expect(html).toContain("22 lançamento(s) · 0 regra(s)");
    expect(html).toContain("Outros &#60;i&#62;x&#60;/i&#62;");
    expect(html).not.toContain("<i>x</i>");
    expect(html).toContain("<strong>“PADARIA”</strong> → Mercado");
    expect(html).toContain("só saídas · só conta · 5 lançamento(s)");
    expect(html).toContain('<span class="etiqueta">do sistema</span>');
    expect(html).toContain("Conta final 8554");
    expect(html).toContain("final 8554 · 362 lançamento(s)");
    expect(html).toContain('href="/ajustes" aria-current="page"');
  });

  it("cria, renomeia e apaga categoria (movendo ou não)", async () => {
    const { post, get } = await loggedIn();
    expect((await post("/ajustes/categorias", [["nome", "Seguros"], ["tipo", "despesa"]])).headers.get("location")).toBe("/ajustes?ok=categoria-criada");
    expect((await post("/ajustes/categorias/1", [["nome", "Supermercado"], ["tipo", "despesa"]])).headers.get("location")).toBe("/ajustes?ok=categoria-salva");
    const moved = await post("/ajustes/categorias/2/apagar", [["mover_para", "1"], ["confirmar", "1"]]);
    expect(moved.headers.get("location")).toBe("/ajustes?ok=categoria-apagada&n=22");
    await post("/ajustes/categorias/2/apagar", [["mover_para", ""], ["confirmar", "1"]]);
    expect(settings.calls).toEqual([
      ["createCategory", { name: "Seguros", kind: "despesa" }],
      ["updateCategory", 1, { name: "Supermercado", kind: "despesa" }],
      ["deleteCategory", 2, { moveTo: 1 }],
      ["deleteCategory", 2, {}],
    ]);
    const html = await (await get("/ajustes?ok=categoria-apagada&n=22")).text();
    expect(html).toContain("Categoria apagada. 22 lançamento(s) mudaram de sugestão ou de categoria.");
  });

  it("apagar sem confirmar não apaga", async () => {
    const { post } = await loggedIn();
    const res = await post("/ajustes/categorias/2/apagar", [["mover_para", "1"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Marque a confirmação");
    expect(settings.calls).toEqual([]);
  });

  it("erros de validação aparecem na própria página", async () => {
    const { post } = await loggedIn();
    const res = await post("/ajustes/categorias", [["nome", "x"], ["tipo", "despesa"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("de 2 a 40 caracteres");
    const rule = await post("/ajustes/regras", [["texto", "ab"], ["direcao", ""], ["conta", ""], ["categoria", "1"]]);
    expect(rule.status).toBe(400);
    expect(await rule.text()).toContain("pelo menos 3 letras");
  });

  it("cria, edita e apaga regra, informando quantos lançamentos mudaram", async () => {
    const { post } = await loggedIn();
    const created = await post("/ajustes/regras", [["texto", "energia"], ["direcao", "saida"], ["conta", "conta"], ["categoria", "1"]]);
    expect(created.headers.get("location")).toBe("/ajustes?ok=regra-criada&n=7");
    await post("/ajustes/regras/10", [["texto", "PADARIA"], ["direcao", ""], ["conta", ""], ["categoria", "2"]]);
    expect((await post("/ajustes/regras/10/apagar", [])).headers.get("location")).toBe("/ajustes?ok=regra-apagada&n=5");
    expect(settings.calls).toEqual([
      ["createRule", { pattern: "energia", direction: "saida", accountKind: "conta", categoryId: 1 }],
      ["updateRule", 10, { pattern: "PADARIA", direction: "", accountKind: "", categoryId: 2 }],
      ["deleteRule", 10],
    ]);
  });

  it("renomeia conta", async () => {
    const { post } = await loggedIn();
    expect((await post("/ajustes/contas/1", [["nome", "C6 conta corrente"]])).headers.get("location")).toBe("/ajustes?ok=conta-salva");
    expect(settings.calls).toEqual([["renameAccount", 1, "C6 conta corrente"]]);
  });

  it("recusa id inválido e envio de outro site", async () => {
    const { post } = await loggedIn();
    expect((await post("/ajustes/categorias/abc", [["nome", "X Y"], ["tipo", "despesa"]])).status).toBe(400);
    expect((await post("/ajustes/regras/1;drop/apagar", [])).status).toBe(400);
    expect((await post("/ajustes/categorias", [["nome", "Seguros"], ["tipo", "despesa"]], "https://site-malicioso.example")).status).toBe(403);
    expect((await post("/ajustes/regras/10/apagar", [], "https://site-malicioso.example")).status).toBe(403);
    expect(settings.calls).toEqual([]);
  });
});
