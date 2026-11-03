import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { type Credentials, type LoginLimiter, type SessionStore, newSessionToken, SESSION_DAYS } from "./auth.js";
import { ImportError, MAX_IMPORT_BYTES, type ImportOutcome, type TransactionRow } from "@jatoba/core";
import { homePage, importPage, loginPage, transactionsPage } from "./pages.js";

export const SESSION_COOKIE = "jatoba_sessao";

export interface AppDeps {
  version: string;
  credentials: Credentials;
  sessions: SessionStore;
  limiter: LoginLimiter;
  /** Endereço público (Tailscale), aceito como origem dos formulários. */
  publicUrl?: string;
  checkDatabase: () => Promise<boolean>;
  /** Quem está tentando entrar, para o limite de tentativas. */
  clientKey: (c: Context) => string;
  ledger: {
    importFile: (fileName: string, bytes: Uint8Array) => Promise<ImportOutcome>;
    list: (opts?: { limit?: number }) => Promise<TransactionRow[]>;
    count: () => Promise<number>;
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const publicOrigin = deps.publicUrl ? new URL(deps.publicUrl).origin : undefined;
  const secureCookie = publicOrigin?.startsWith("https://") ?? false;

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    }),
  );

  // Formulários só são aceitos vindos da própria página.
  app.use(
    "*",
    csrf({
      origin: (origin, c) => origin === new URL(c.req.url).origin || origin === publicOrigin,
    }),
  );

  app.get("/health", async (c) => {
    const database = await deps.checkDatabase();
    return c.json({ status: database ? "ok" : "erro", database: database ? "ok" : "fora do ar", version: deps.version }, database ? 200 : 503);
  });

  const isLoggedIn = async (c: Context) => {
    const token = getCookie(c, SESSION_COOKIE);
    return token !== undefined && (await deps.sessions.isValid(token));
  };

  app.get("/entrar", async (c) => {
    if (await isLoggedIn(c)) return c.redirect("/", 303);
    return c.html(loginPage());
  });

  app.post("/entrar", bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const key = deps.clientKey(c);
    const wait = deps.limiter.retryAfter(key);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.html(loginPage(`Muitas tentativas erradas. Tente de novo em ${minutes} min.`), 429);
    }

    const form = await c.req.parseBody();
    const user = typeof form.usuario === "string" ? form.usuario.trim() : "";
    const password = typeof form.senha === "string" ? form.senha : "";

    if (!(await deps.credentials.verify(user, password))) {
      deps.limiter.fail(key);
      return c.html(loginPage("Usuário ou senha incorretos."), 401);
    }

    deps.limiter.succeed(key);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60_000);
    await deps.sessions.create(token, expiresAt);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: secureCookie,
      path: "/",
      expires: expiresAt,
    });
    return c.redirect("/", 303);
  });

  app.post("/sair", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deps.sessions.delete(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookie });
    return c.redirect("/entrar", 303);
  });

  // Daqui para baixo, tudo exige login.
  app.use("*", async (c, next) => {
    if (!(await isLoggedIn(c))) {
      return c.req.method === "GET" ? c.redirect("/entrar", 303) : c.text("Faça login.", 401);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/", async (c) => c.html(homePage(deps.version, await deps.ledger.count())));

  app.get("/importar", (c) => c.html(importPage()));

  app.post(
    "/importar",
    bodyLimit({
      maxSize: MAX_IMPORT_BYTES + 64 * 1024,
      onError: (c) => c.html(importPage({ error: "Arquivo grande demais (máximo de 10 MB)." }), 413),
    }),
    async (c) => {
      const form = await c.req.parseBody();
      const file = form.arquivo;
      if (!(file instanceof File) || file.size === 0) {
        return c.html(importPage({ error: "Escolha um arquivo para importar." }), 400);
      }
      try {
        const outcome = await deps.ledger.importFile(file.name, new Uint8Array(await file.arrayBuffer()));
        return c.html(importPage({ outcome }));
      } catch (error) {
        if (error instanceof ImportError || (error instanceof Error && /^(Ofx|Csv)Error$/.test(error.name))) {
          return c.html(importPage({ error: error.message }), 422);
        }
        throw error;
      }
    },
  );

  app.get("/lancamentos", async (c) => {
    const [rows, total] = await Promise.all([deps.ledger.list({ limit: 500 }), deps.ledger.count()]);
    return c.html(transactionsPage(rows, total));
  });

  return app;
}
