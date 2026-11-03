import { beforeEach, describe, expect, it } from "vitest";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";
import { DuplicateError, readStatementFile, type Category, type ImportOutcome, type MonthSummary, type ReviewRow, type SuspectPair, type TransactionFilter, type TransactionRow } from "@jatoba/core";

const NOVEMBRO: MonthSummary = {
  month: "2026-11-01",
  currency: "BRL",
  income: 801500,
  expenses: 55000,
  net: 746500,
  expenseCategories: [
    { categoryId: 1, name: "Mercado", kind: "despesa", total: 40000, count: 1, outflow: 40000, inflow: 0, previousAverage: 32000 },
    { categoryId: 4, name: "Restaurantes <b>e</b> delivery", kind: "despesa", total: 12000, count: 2, outflow: 12000, inflow: 0, previousAverage: 20000 },
  ],
  incomeCategories: [{ categoryId: 2, name: "Salário", kind: "receita", total: 800000, count: 1, outflow: 0, inflow: 800000, previousAverage: 750000 }],
  movements: [{ categoryId: 3, name: "Pagamento de fatura", kind: "movimentacao", total: 0, count: 2, outflow: 250000, inflow: 250000 }],
  uncategorized: { outflow: 3000, outflowCount: 1, inflow: 1500, inflowCount: 1 },
  coverage: [
    { accountId: 2, name: "Cartão C6", kind: "cartao", count: 6 },
    { accountId: 1, name: "Conta final 8554", kind: "conta", count: 5 },
  ],
  previousMonths: ["2026-10-01", "2026-09-01"],
};

const CATEGORIES: Category[] = [
  { id: 1, name: "Mercado", kind: "despesa" },
  { id: 2, name: "Salário", kind: "receita" },
  { id: 3, name: "Pagamento de fatura", kind: "movimentacao" },
];

/** Revisão em memória, que registra o que a página pediu. */
function memoryReview() {
  const rows: ReviewRow[] = [
    { id: "10", date: "2026-10-01", amount: -1234, currency: "BRL", description: "COMPRA <b>MERCADO</b>", cleanDescription: "<b>MERCADO</b>", accountName: "Conta", accountKind: "conta", categoryId: null, categorySource: null, rulePattern: null, bankCategory: null },
    { id: "11", date: "2026-10-02", amount: -500, currency: "BRL", description: "PAGAMENTO FATURA", cleanDescription: "PAGAMENTO FATURA", accountName: "Conta", accountKind: "conta", categoryId: 3, categorySource: "regra", rulePattern: "FATURA", bankCategory: null },
  ];
  const calls: { set: unknown[]; approve: string[][]; resolve: unknown[] } = { set: [], approve: [], resolve: [] };
  const suspects: SuspectPair[] = [
    { id: "20", date: "2026-10-17", amount: 8010, currency: "BRL", accountName: "Conta", description: "TRANSFERENCIA <i>ORIGEM</i>", fileName: "agosto-a-novembro.ofx",
      original: { id: "5", description: "PIX RECEBIDO", fileName: "outubro.ofx", categoryName: "Reembolsos", reviewed: true } },
  ];
  return {
    rows,
    calls,
    async categories() {
      return CATEGORIES;
    },
    async list() {
      return { rows, total: rows.length, withSuggestion: rows.filter((r) => r.categoryId !== null).length };
    },
    async setCategory(id: string, categoryId: number, opts: { rulePattern?: string } = {}) {
      if (opts.rulePattern !== undefined && opts.rulePattern.trim().length < 3) {
        const { CategoryError } = await import("@jatoba/core");
        throw new CategoryError("O texto da regra precisa ter pelo menos 3 letras.");
      }
      calls.set.push([id, categoryId, opts]);
      return { otherChanged: opts.rulePattern ? 4 : 0, ruleCreated: opts.rulePattern !== undefined };
    },
    async approve(ids: string[]) {
      calls.approve.push(ids);
      return ids.length;
    },
    async suspects() {
      return suspects;
    },
    async resolve(id: string, decision: "duplicado" | "distinto") {
      if (!suspects.some((x) => x.id === id)) throw new DuplicateError("Este lançamento não está marcado como possível duplicado.");
      calls.resolve.push([id, decision]);
      suspects.splice(suspects.findIndex((x) => x.id === id), 1);
    },
  };
}

/** Livro-caixa em memória: lê o arquivo de verdade e guarda os lançamentos numa lista. */
function memoryLedger() {
  const rows: TransactionRow[] = [];
  return {
    rows,
    async importFile(fileName: string, bytes: Uint8Array): Promise<ImportOutcome> {
      const { statements, warnings } = readStatementFile(bytes);
      const s = statements[0]!;
      for (const t of s.transactions) {
        rows.push({ id: String(rows.length + 1), date: t.date, amount: t.amount, currency: s.currency, description: t.description, accountName: "Conta teste" });
      }
      return {
        fileName,
        statements: [{ importId: 1, accountId: 1, accountName: "Conta teste", format: "ofx", total: s.transactions.length, inserted: s.transactions.length, duplicates: 0, suspects: fileName.includes("suspeito") ? 1 : 0 }],
        warnings,
      };
    },
    async list(opts: { limit?: number; offset?: number } = {}) {
      const ordered = [...rows].reverse();
      const offset = opts.offset ?? 0;
      return ordered.slice(offset, offset + (opts.limit ?? ordered.length));
    },
    async count() {
      return rows.length;
    },
  };
}

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";

let databaseUp: boolean;
let ledger: ReturnType<typeof memoryLedger>;
let review: ReturnType<typeof memoryReview>;
let monthCalls: string[];
let months: string[];
let summaries: Record<string, MonthSummary>;
let lastFilter: TransactionFilter | undefined;

async function makeApp(publicUrl?: string) {
  return createApp({
    version: "teste",
    credentials: await Credentials.create(USER, PASSWORD),
    sessions: new MemorySessionStore(),
    limiter: new LoginLimiter(3),
    publicUrl,
    checkDatabase: async () => databaseUp,
    clientKey: () => "teste",
    ledger: {
      ...ledger,
      list: async (opts: { limit?: number; offset?: number; filter?: TransactionFilter } = {}) => {
        lastFilter = opts.filter;
        return ledger.list(opts);
      },
      count: async (filter?: TransactionFilter) => {
        lastFilter = filter;
        return ledger.count();
      },
    },
    review,
    goals: {
      today: () => "2026-11-03", list: async () => [], entries: async () => [], investments: async () => [],
      create: async () => 1, update: async () => {}, setArchived: async () => {}, delete: async () => {},
      addEntry: async () => {}, deleteEntry: async () => {}, assign: async () => {},
    },
    settings: {
      categories: async () => [], rules: async () => [], accounts: async () => [],
      createCategory: async () => 1, updateCategory: async () => {}, deleteCategory: async () => 0,
      createRule: async () => 0, updateRule: async () => 0, deleteRule: async () => 0, renameAccount: async () => {},
    },
    month: {
      months: async () => months,
      summary: async (m: string) => {
        monthCalls.push(m);
        return summaries[m]!;
      },
    },
  });
}

function login(app: Awaited<ReturnType<typeof makeApp>>, usuario: string, senha: string, origin = ORIGIN) {
  return app.request("/entrar", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
    body: new URLSearchParams({ usuario, senha }).toString(),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) throw new Error(`sem cookie de sessão: ${header}`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

beforeEach(() => {
  databaseUp = true;
  ledger = memoryLedger();
  review = memoryReview();
  monthCalls = [];
  months = ["2026-11-01", "2026-10-01", "2026-09-01"];
  summaries = {
    "2026-11-01": NOVEMBRO,
    "2026-10-01": { ...NOVEMBRO, month: "2026-10-01", previousMonths: ["2026-09-01"], coverage: [{ accountId: 2, name: "Cartão C6", kind: "cartao", count: 0 }, { accountId: 1, name: "Conta final 8554", kind: "conta", count: 9 }] },
  };
  lastFilter = undefined;
});

describe("app", () => {
  it("/health responde sem login e reflete o banco", async () => {
    const app = await makeApp();
    const ok = await app.request("/health");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", version: "teste" });

    databaseUp = false;
    expect((await app.request("/health")).status).toBe(503);
  });

  it("sem login, a página inicial manda para /entrar", async () => {
    const app = await makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/entrar");
  });

  it("entra com a senha certa, usa a sessão e sai", async () => {
    const app = await makeApp();
    const res = await login(app, USER, PASSWORD);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const cookie = sessionCookie(res);

    const home = await app.request("/", { headers: { Cookie: cookie } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Sair");
    expect(home.headers.get("cache-control")).toBe("no-store");

    const logout = await app.request("/sair", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" } });
    expect(logout.headers.get("location")).toBe("/entrar");
    expect((await app.request("/", { headers: { Cookie: cookie } })).status).toBe(303);
  });

  it("recusa senha errada sem criar sessão", async () => {
    const app = await makeApp();
    const res = await login(app, USER, "senha-errada-mas-comprida");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("Usuário ou senha incorretos");
  });

  it("bloqueia depois de muitas tentativas, mesmo com a senha certa", async () => {
    const app = await makeApp();
    for (let i = 0; i < 3; i++) await login(app, USER, "errada-errada-errada");
    const res = await login(app, USER, PASSWORD);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("recusa formulário vindo de outro site (CSRF)", async () => {
    const app = await makeApp();
    const res = await login(app, USER, PASSWORD, "https://site-malicioso.example");
    expect(res.status).toBe(403);
  });

  it("aceita o endereço do Tailscale como origem e marca o cookie como Secure", async () => {
    const app = await makeApp("https://jatoba.exemplo.ts.net");
    const res = await login(app, USER, PASSWORD, "https://jatoba.exemplo.ts.net");
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("cookie inventado não dá acesso", async () => {
    const app = await makeApp();
    const res = await app.request("/", { headers: { Cookie: `${SESSION_COOKIE}=inventado` } });
    expect(res.status).toBe(303);
  });
});

async function loggedIn() {
  const app = await makeApp();
  const cookie = sessionCookie(await login(app, USER, PASSWORD));
  return { app, cookie };
}

function upload(app: Awaited<ReturnType<typeof makeApp>>, cookie: string, name: string, content: string | Uint8Array, origin = ORIGIN) {
  const form = new FormData();
  form.append("arquivo", new File([content], name));
  return app.request("/importar", { method: "POST", body: form, headers: { Cookie: cookie, Origin: origin } });
}

const OFX = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><ACCTID>12345</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-12.34<FITID>A<MEMO>PADARIA EXEMPLO</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261002<TRNAMT>100.00<FITID>B<MEMO>&lt;script&gt;alert(1)&lt;/script&gt;</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("importar e lançamentos", () => {
  it("as páginas novas exigem login", async () => {
    const app = await makeApp();
    expect((await app.request("/importar")).status).toBe(303);
    expect((await app.request("/lancamentos")).status).toBe(303);
    const form = new FormData();
    form.append("arquivo", new File([OFX], "x.ofx"));
    expect((await app.request("/importar", { method: "POST", body: form, headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it("importa um arquivo enviado e mostra o resumo", async () => {
    const { app, cookie } = await loggedIn();
    const res = await upload(app, cookie, "extrato.ofx", OFX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("extrato.ofx</strong> importado");
    expect(html).toContain("2 novo(s)");
    expect(ledger.rows).toHaveLength(2);
  });

  it("descrição maliciosa vinda do extrato aparece como texto, sem virar código", async () => {
    const { app, cookie } = await loggedIn();
    await upload(app, cookie, "extrato.ofx", OFX);
    const html = await (await app.request("/lancamentos", { headers: { Cookie: cookie } })).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
    expect(html).toContain("PADARIA EXEMPLO");
    expect(html.replace(/\s/g, " ")).toContain("-R$ 12,34");
  });

  it("formato desconhecido mostra o erro na própria página", async () => {
    const { app, cookie } = await loggedIn();
    const res = await upload(app, cookie, "planilha.csv", "Data,Valor\n01/10/2026,1");
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Formato não reconhecido");
  });

  it("sem arquivo, pede um arquivo", async () => {
    const { app, cookie } = await loggedIn();
    const form = new FormData();
    const res = await app.request("/importar", { method: "POST", body: form, headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(res.status).toBe(400);
  });

  it("envio vindo de outro site é bloqueado (CSRF)", async () => {
    const { app, cookie } = await loggedIn();
    expect((await upload(app, cookie, "x.ofx", OFX, "https://site-malicioso.example")).status).toBe(403);
    expect(ledger.rows).toHaveLength(0);
  });

  it("arquivo acima de 10 MB é recusado", async () => {
    const { app, cookie } = await loggedIn();
    const res = await upload(app, cookie, "grande.ofx", new Uint8Array(11 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(ledger.rows).toHaveLength(0);
  });

  it("a página inicial mostra quantos lançamentos existem", async () => {
    const { app, cookie } = await loggedIn();
    expect(await (await app.request("/", { headers: { Cookie: cookie } })).text()).toContain("Nenhum lançamento ainda");
    await upload(app, cookie, "extrato.ofx", OFX);
    expect(await (await app.request("/", { headers: { Cookie: cookie } })).text()).toContain("2 lançamento(s) importado(s)");
  });
});

function post(app: Awaited<ReturnType<typeof makeApp>>, path: string, cookie: string, fields: [string, string][], origin = ORIGIN) {
  return app.request(path, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("revisar", () => {
  it("exige login", async () => {
    const app = await makeApp();
    expect((await app.request("/revisar")).status).toBe(303);
    expect((await app.request("/revisar/10", { method: "POST", headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it("mostra os lançamentos, a sugestão e escapa descrições", async () => {
    const { app, cookie } = await loggedIn();
    const html = await (await app.request("/revisar", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("2 lançamento(s) para revisar, 1 com sugestão");
    expect(html).toContain("pela regra “FATURA”");
    expect(html).toContain("Aprovar as 1 sugestões desta página");
    expect(html).not.toContain("<b>MERCADO</b>");
    expect(html).toContain("&#60;b&#62;MERCADO&#60;/b&#62;");
    expect(html).toContain('<option value="3" selected>Pagamento de fatura</option>');
    expect(html).toContain("Escolha a categoria");
  });

  it("salva a categoria e volta para a revisão", async () => {
    const { app, cookie } = await loggedIn();
    const res = await post(app, "/revisar/10", cookie, [["categoria", "1"], ["regra", "MERCADO"]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/revisar?salvo=1&outros=0");
    expect(review.calls.set).toEqual([["10", 1, {}]]);
  });

  it("com “usar sempre”, cria a regra e conta os parecidos", async () => {
    const { app, cookie } = await loggedIn();
    const res = await post(app, "/revisar/10", cookie, [["categoria", "1"], ["criar_regra", "1"], ["regra", "MERCADO"]]);
    expect(res.headers.get("location")).toBe("/revisar?salvo=regra&outros=4");
    expect(review.calls.set).toEqual([["10", 1, { rulePattern: "MERCADO" }]]);
    const html = await (await app.request(res.headers.get("location")!, { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Categoria salva e regra criada; 4 outro(s) lançamento(s) ganharam sugestão.");
  });

  it("regra curta demais mostra o erro na página", async () => {
    const { app, cookie } = await loggedIn();
    const res = await post(app, "/revisar/10", cookie, [["categoria", "1"], ["criar_regra", "1"], ["regra", "ab"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("pelo menos 3 letras");
  });

  it("recusa categoria vazia e id inválido", async () => {
    const { app, cookie } = await loggedIn();
    expect((await post(app, "/revisar/10", cookie, [["categoria", ""]])).status).toBe(400);
    expect((await post(app, "/revisar/abc", cookie, [["categoria", "1"]])).status).toBe(404);
    expect(review.calls.set).toEqual([]);
  });

  it("aprova em lote só ids numéricos", async () => {
    const { app, cookie } = await loggedIn();
    const res = await post(app, "/revisar/aprovar", cookie, [["id", "11"], ["id", "12"], ["id", "1; drop table"]]);
    expect(res.headers.get("location")).toBe("/revisar?aprovados=2");
    expect(review.calls.approve).toEqual([["11", "12"]]);
  });

  it("formulário vindo de outro site é bloqueado (CSRF)", async () => {
    const { app, cookie } = await loggedIn();
    expect((await post(app, "/revisar/10", cookie, [["categoria", "1"]], "https://site-malicioso.example")).status).toBe(403);
    expect((await post(app, "/revisar/aprovar", cookie, [["id", "11"]], "https://site-malicioso.example")).status).toBe(403);
    expect(review.calls.set).toEqual([]);
    expect(review.calls.approve).toEqual([]);
  });

  it("a página inicial avisa quantos faltam revisar", async () => {
    const { app, cookie } = await loggedIn();
    await upload(app, cookie, "extrato.ofx", OFX);
    expect(await (await app.request("/", { headers: { Cookie: cookie } })).text()).toContain("3 lançamento(s) para revisar"); // 2 de categoria + 1 possível duplicado
  });
});

describe("paginação de lançamentos", () => {
  async function withRows(n: number) {
    const { app, cookie } = await loggedIn();
    for (let i = 1; i <= n; i++) {
      ledger.rows.push({ id: String(i), date: "2026-10-01", amount: -i, currency: "BRL", description: `LANCAMENTO ${String(i).padStart(3, "0")}`, accountName: "Conta" });
    }
    const page = async (q = "") => (await app.request(`/lancamentos${q}`, { headers: { Cookie: cookie } })).text();
    return page;
  }

  it("até 50 lançamentos: uma página, sem navegação", async () => {
    const html = await (await withRows(50))();
    expect(html).not.toContain('class="paginas"');
    expect((html.match(/LANCAMENTO \d{3}/g) ?? []).length).toBe(50);
  });

  it("120 lançamentos: 3 páginas de até 50, do mais recente para o mais antigo", async () => {
    const page = await withRows(120);
    const first = await page();
    expect(first).toContain("Página 1 de 3");
    expect(first).toContain("mostrando de 1 a 50");
    expect(first).toContain("LANCAMENTO 120");
    expect(first).not.toContain("LANCAMENTO 070");
    expect(first).toContain('href="/lancamentos?pagina=2" rel="next"');
    expect(first).toContain('<span class="desligado" aria-disabled="true">‹ Anterior</span>');

    const second = await page("?pagina=2");
    expect(second).toContain("Página 2 de 3");
    expect(second).toContain("LANCAMENTO 070");
    expect(second).toContain('href="/lancamentos?pagina=1" rel="prev"');

    const last = await page("?pagina=3");
    expect(last).toContain("mostrando de 101 a 120");
    expect((last.match(/LANCAMENTO \d{3}/g) ?? []).length).toBe(20);
    expect(last).toContain('<span class="desligado" aria-disabled="true">Próxima ›</span>');
  });

  it("página fora do intervalo ou inválida vai para a mais próxima", async () => {
    const page = await withRows(120);
    expect(await page("?pagina=99")).toContain("Página 3 de 3");
    expect(await page("?pagina=0")).toContain("Página 1 de 3");
    expect(await page("?pagina=abc")).toContain("Página 1 de 3");
    expect(await page("?pagina=-5")).toContain("Página 1 de 3");
  });
});

describe("possíveis duplicados na página", () => {
  it("aparecem antes das categorias, lado a lado e escapados", async () => {
    const { app, cookie } = await loggedIn();
    const html = await (await app.request("/revisar", { headers: { Cookie: cookie } })).text();
    expect(html.indexOf("Possíveis duplicados")).toBeLessThan(html.indexOf("lançamento(s) para revisar"));
    expect(html).toContain("Já existia (de outubro.ofx) · Reembolsos");
    expect(html).toContain("Chegou agora (de agosto-a-novembro.ofx)");
    expect(html).toContain("&#60;i&#62;ORIGEM&#60;/i&#62;");
    expect(html.replace(/\s/g, " ")).toContain("R$ 80,10");
  });

  it("“é o mesmo” descarta e volta com mensagem", async () => {
    const { app, cookie } = await loggedIn();
    const res = await post(app, "/duplicados/20", cookie, [["decisao", "duplicado"]]);
    expect(res.headers.get("location")).toBe("/revisar?duplicado=descartado");
    expect(review.calls.resolve).toEqual([["20", "duplicado"]]);
    const html = await (await app.request(res.headers.get("location")!, { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Duplicado descartado");
    expect(html).not.toContain("Possíveis duplicados");
  });

  it("“são diferentes” mantém os dois", async () => {
    const { app, cookie } = await loggedIn();
    const res = await post(app, "/duplicados/20", cookie, [["decisao", "distinto"]]);
    expect(res.headers.get("location")).toBe("/revisar?duplicado=mantido");
    expect(review.calls.resolve).toEqual([["20", "distinto"]]);
  });

  it("recusa decisão inválida, id inválido, não suspeito e envio de outro site", async () => {
    const { app, cookie } = await loggedIn();
    expect((await post(app, "/duplicados/20", cookie, [["decisao", "apagar"]])).status).toBe(400);
    expect((await post(app, "/duplicados/x", cookie, [["decisao", "duplicado"]])).status).toBe(404);
    expect((await post(app, "/duplicados/999", cookie, [["decisao", "duplicado"]])).status).toBe(400);
    expect((await post(app, "/duplicados/20", cookie, [["decisao", "duplicado"]], "https://site-malicioso.example")).status).toBe(403);
    expect(review.calls.resolve).toEqual([]);
  });

  it("a importação avisa quando encontra possíveis duplicados", async () => {
    const { app, cookie } = await loggedIn();
    const html = await (await upload(app, cookie, "suspeito.ofx", OFX)).text();
    expect(html).toContain("1 possível(is) duplicado(s)");
  });

});

describe("tela do Mês", () => {
  const get = async (path: string) => {
    const { app, cookie } = await loggedIn();
    return app.request(path, { headers: { Cookie: cookie } });
  };

  it("exige login", async () => {
    const app = await makeApp();
    expect((await app.request("/mes")).status).toBe(303);
  });

  it("sem mês pedido, mostra o mais recente com dados", async () => {
    const html = await (await get("/mes")).text();
    expect(monthCalls).toEqual(["2026-11-01"]);
    expect(html).toContain("<h1>Novembro de 2026</h1>");
  });

  it("resumo, categorias, sem categoria, movimentações e comparação", async () => {
    const html = (await (await get("/mes?m=2026-11")).text()).replace(/\s/g, " ");
    expect(html).toContain("R$ 8.015,00"); // entradas
    expect(html).toContain("R$ 550,00"); // saídas
    expect(html).toContain("R$ 7.465,00"); // saldo
    expect(html).toContain('href="/lancamentos?mes=2026-11&amp;categoria=1">Mercado</a>');
    expect(html).toContain('href="/lancamentos?mes=2026-11&amp;categoria=sem">Sem categoria</a>');
    expect(html).toContain("Restaurantes &#60;b&#62;e&#60;/b&#62; delivery");
    expect(html).toContain('<span class="pior">+25%</span>'); // mercado subiu: ruim
    expect(html).toContain('<span class="melhor">−40%</span>'); // restaurante caiu: bom
    expect(html).toContain('<span class="melhor">+7%</span>'); // salário subiu: bom
    expect(html).toContain("Pagamento de fatura");
    expect(html).toContain("2 lançamento(s) sem categoria estão contados nos totais");
    expect(html).toContain("outubro de 2026, setembro de 2026");
    expect(html).not.toContain("Mês incompleto");
  });

  it("navega entre meses com dados", async () => {
    const html = await (await get("/mes?m=2026-10")).text();
    expect(html).toContain('href="/mes?m=2026-09" rel="prev"');
    expect(html).toContain('href="/mes?m=2026-11" rel="next"');
    const newest = await (await get("/mes?m=2026-11")).text();
    expect(newest).not.toContain('rel="next"');
  });

  it("avisa quando falta o extrato de uma conta no mês", async () => {
    const html = await (await get("/mes?m=2026-10")).text();
    expect(html).toContain("Mês incompleto");
    expect(html).toContain("Cartão C6 não tem lançamentos neste mês (falta importar a fatura?)");
  });

  it("mês inválido ou sem dados vai para o mais recente", async () => {
    await get("/mes?m=2030-01");
    await get("/mes?m=abc");
    expect(monthCalls).toEqual(["2026-11-01", "2026-11-01"]);
  });

  it("sem nenhum lançamento, convida a importar", async () => {
    months = [];
    const html = await (await get("/mes")).text();
    expect(html).toContain("Importe um extrato");
  });

  it("Lançamentos aceita os filtros vindos do Mês e preserva na paginação", async () => {
    const html = await (await get("/lancamentos?mes=2026-11&categoria=sem")).text();
    expect(lastFilter).toEqual({ month: "2026-11-01", category: "sem" });
    await upload((await loggedIn()).app, (await loggedIn()).cookie, "x.ofx", OFX);
    expect(html).toContain("Filtrando:");
    const byCategory = await get("/lancamentos?mes=2026-11&categoria=1");
    expect(await byCategory.text()).toContain("<strong>Mercado</strong>");
    expect(lastFilter).toEqual({ month: "2026-11-01", category: 1 });
  });

  it("filtros inválidos são ignorados", async () => {
    await get("/lancamentos?mes=2026-13&categoria=1;drop");
    expect(lastFilter).toEqual({});
  });
});
