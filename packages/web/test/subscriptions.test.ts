import { beforeEach, describe, expect, it } from "vitest";
import { detectSubscriptions, type SubscriptionList } from "@jatoba/core";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";
const TODAY = "2026-11-04";

let list: SubscriptionList;
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
    review: { categories: empty, list: async () => ({ rows: [], total: 0, withSuggestion: 0 }), setCategory: async () => ({ otherChanged: 0, ruleCreated: false }), approve: async () => 0, suspects: empty, resolve: async () => {} },
    month: { months: empty, summary: async () => { throw new Error("sem meses"); } },
    settings: { categories: empty, rules: empty, accounts: empty, createCategory: async () => 1, updateCategory: async () => {}, deleteCategory: async () => 0, createRule: async () => 0, updateRule: async () => 0, deleteRule: async () => 0, renameAccount: async () => {} },
    transaction: { get: async () => undefined, reopen: async () => {} },
    subscriptions: {
      list: async () => list,
      ignore: async (key, name) => void calls.push(["ignore", key, name]),
      unignore: async (key) => void calls.push(["unignore", key]),
    },
    goals: { today: () => TODAY, list: empty, entries: empty, investments: empty, create: async () => 1, update: async () => {}, setArchived: async () => {}, delete: async () => {}, addEntry: async () => {}, deleteEntry: async () => {}, assign: async () => {} },
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
  const found = detectSubscriptions(
    [
      { date: "2026-09-14", amount: 3990, description: "STREAMING <b>X</b>", categoryName: "Assinaturas" },
      { date: "2026-10-14", amount: 4490, description: "STREAMING <b>X</b>", categoryName: "Assinaturas" },
      { date: "2026-09-01", amount: 9900, description: "ACADEMIA", categoryName: null },
      { date: "2026-10-01", amount: 9900, description: "ACADEMIA", categoryName: null },
      { date: "2026-06-05", amount: 2000, description: "REVISTA", categoryName: null },
      { date: "2026-07-05", amount: 2000, description: "REVISTA", categoryName: null },
    ],
    TODAY,
  );
  const active = found.filter((s) => s.active);
  list = { active, stopped: found.filter((s) => !s.active), ignored: [{ key: "PIX MENSAL", name: "Pix mensal" }], monthlyTotal: active.reduce((a, s) => a + s.lastAmount, 0) };
});

describe("Assinaturas", () => {
  it("exige login", async () => {
    const { app } = await setup();
    expect((await app.request("/assinaturas")).status).toBe(303);
  });

  it("mostra total, reajuste, próxima cobrança, atrasada, paradas e ignoradas; tudo escapado", async () => {
    const { get } = await setup();
    const html = (await (await get("/assinaturas")).text()).replace(/\s/g, " ");
    expect(html).toContain("R$ 143,90"); // 44,90 + 99,00 por mês
    expect(html).toContain("R$ 1.726,80"); // por ano
    expect(html).toContain("STREAMING &#60;b&#62;X&#60;/b&#62;");
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain('<span class="pior">subiu de R$ 39,90</span>');
    expect(html).toContain("próxima por volta de 14/11/2026");
    expect(html).toContain("prevista para 01/11/2026, ainda não apareceu"); // academia
    expect(html).toContain("Pararam");
    expect(html).toContain("sem cobrança desde 05/07/2026");
    expect(html).toContain("Pix mensal");
    expect(html).toContain('href="/assinaturas" aria-current="page"');
  });

  it("“não é assinatura” e “voltar a mostrar”", async () => {
    const { post, get } = await setup();
    const res = await post("/assinaturas/ignorar", [["chave", "ACADEMIA"], ["nome", "ACADEMIA"]]);
    expect(res.headers.get("location")).toBe("/assinaturas?ok=ignorada");
    await post("/assinaturas/voltar", [["chave", "PIX MENSAL"]]);
    expect(calls).toEqual([["ignore", "ACADEMIA", "ACADEMIA"], ["unignore", "PIX MENSAL"]]);
    expect(await (await get("/assinaturas?ok=ignorada")).text()).toContain("Marcada como");
  });

  it("recusa chave inválida e envio de outro site", async () => {
    const { post } = await setup();
    expect((await post("/assinaturas/ignorar", [["chave", "x'; drop"]])).status).toBe(400);
    expect((await post("/assinaturas/ignorar", [["chave", "ACADEMIA"]], "https://site-malicioso.example")).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
