import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { type Credentials, type LoginLimiter, type SessionStore, newSessionToken, SESSION_DAYS } from "./auth.js";
import { CategoryError, DuplicateError, ImportError, MAX_IMPORT_BYTES, type Category, type ImportOutcome, type ReviewRow, type SuspectPair, type TransactionRow } from "@jatoba/core";
import { homePage, importPage, loginPage, reviewPage, transactionsPage } from "./pages.js";

export const SESSION_COOKIE = "jatoba_sessao";
export const PAGE_SIZE = 50;

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
    list: (opts?: { limit?: number; offset?: number }) => Promise<TransactionRow[]>;
    count: () => Promise<number>;
  };
  review: {
    categories: () => Promise<Category[]>;
    list: (opts?: { limit?: number }) => Promise<{ rows: ReviewRow[]; total: number; withSuggestion: number }>;
    setCategory: (id: string, categoryId: number, opts?: { rulePattern?: string }) => Promise<{ otherChanged: number; ruleCreated: boolean }>;
    approve: (ids: string[]) => Promise<number>;
    suspects: () => Promise<SuspectPair[]>;
    resolve: (id: string, decision: "duplicado" | "distinto") => Promise<void>;
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

  app.get("/", async (c) => {
    const [count, review, suspects] = await Promise.all([deps.ledger.count(), deps.review.list({ limit: 1 }), deps.review.suspects()]);
    return c.html(homePage(deps.version, count, review.total + suspects.length));
  });

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
    const total = await deps.ledger.count();
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const requested = Number.parseInt(c.req.query("pagina") ?? "1", 10);
    const page = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), pages) : 1;
    const rows = await deps.ledger.list({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    return c.html(transactionsPage(rows, total, { page, pages, pageSize: PAGE_SIZE }));
  });

  const showReview = async (c: Context, flash: { message?: string; error?: string } = {}, status: 200 | 400 = 200) => {
    const [list, categories, suspects] = await Promise.all([deps.review.list({ limit: 50 }), deps.review.categories(), deps.review.suspects()]);
    return c.html(reviewPage({ ...list, categories, suspects, ...flash }), status);
  };

  app.get("/revisar", (c) => {
    const salvo = c.req.query("salvo");
    const outros = Number(c.req.query("outros") ?? 0);
    const aprovados = c.req.query("aprovados");
    const duplicado = c.req.query("duplicado");
    let message: string | undefined;
    if (duplicado === "descartado") message = "Duplicado descartado. Ele não aparece mais e não volta em novas importações.";
    else if (duplicado === "mantido") message = "Mantidos os dois lançamentos.";
    else if (aprovados !== undefined) message = `${Number(aprovados) || 0} sugestão(ões) aprovada(s).`;
    else if (salvo === "regra") message = `Categoria salva e regra criada${outros > 0 ? `; ${outros} outro(s) lançamento(s) ganharam sugestão` : ""}.`;
    else if (salvo !== undefined) message = "Categoria salva.";
    return showReview(c, { message });
  });

  app.post("/revisar/aprovar", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const form = await c.req.parseBody({ all: true });
    const raw = form.id;
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const ids = values.filter((v): v is string => typeof v === "string" && /^\d+$/.test(v));
    const approved = await deps.review.approve(ids);
    return c.redirect(`/revisar?aprovados=${approved}`, 303);
  });

  app.post("/revisar/:id", bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) return c.text("Lançamento inválido.", 404);
    const form = await c.req.parseBody();
    const categoryId = Number(form.categoria);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return showReview(c, { error: "Escolha uma categoria." }, 400);
    const wantsRule = form.criar_regra === "1";
    const pattern = typeof form.regra === "string" ? form.regra : "";
    try {
      const result = await deps.review.setCategory(id, categoryId, wantsRule ? { rulePattern: pattern } : {});
      return c.redirect(`/revisar?salvo=${result.ruleCreated ? "regra" : "1"}&outros=${result.otherChanged}`, 303);
    } catch (error) {
      if (error instanceof CategoryError) return showReview(c, { error: error.message }, 400);
      throw error;
    }
  });

  app.post("/duplicados/:id", bodyLimit({ maxSize: 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) return c.text("Lançamento inválido.", 404);
    const form = await c.req.parseBody();
    const decision = form.decisao;
    if (decision !== "duplicado" && decision !== "distinto") return showReview(c, { error: "Decisão inválida." }, 400);
    try {
      await deps.review.resolve(id, decision);
    } catch (error) {
      if (error instanceof DuplicateError) return showReview(c, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/revisar?duplicado=${decision === "duplicado" ? "descartado" : "mantido"}`, 303);
  });

  return app;
}
