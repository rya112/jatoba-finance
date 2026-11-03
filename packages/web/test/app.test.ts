import { beforeEach, describe, expect, it } from "vitest";
import { createApp, SESSION_COOKIE } from "../src/app.js";
import { Credentials, LoginLimiter, MemorySessionStore } from "../src/auth.js";

const USER = "ricardo";
const PASSWORD = "uma-frase-bem-longa-de-teste";
const ORIGIN = "http://localhost";

let databaseUp: boolean;

async function makeApp(publicUrl?: string) {
  return createApp({
    version: "teste",
    credentials: await Credentials.create(USER, PASSWORD),
    sessions: new MemorySessionStore(),
    limiter: new LoginLimiter(3),
    publicUrl,
    checkDatabase: async () => databaseUp,
    clientKey: () => "teste",
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
