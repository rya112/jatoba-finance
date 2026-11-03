import { beforeEach, describe, expect, it } from "vitest";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";
import { ImportError, readStatementFile, type ImportOutcome, type TransactionRow } from "@jatoba/core";

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
        statements: [{ importId: 1, accountId: 1, accountName: "Conta teste", format: "ofx", total: s.transactions.length, inserted: s.transactions.length, duplicates: 0 }],
        warnings,
      };
    },
    async list() {
      return [...rows].reverse();
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

async function makeApp(publicUrl?: string) {
  return createApp({
    version: "teste",
    credentials: await Credentials.create(USER, PASSWORD),
    sessions: new MemorySessionStore(),
    limiter: new LoginLimiter(3),
    publicUrl,
    checkDatabase: async () => databaseUp,
    clientKey: () => "teste",
    ledger,
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
