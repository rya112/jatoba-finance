import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { type Credentials, type LoginLimiter, type SessionStore, newSessionToken } from "./auth.js";
import { CategoryError, DuplicateError, GoalError, ImportError, MAX_IMPORT_BYTES, type AccountInfo, type AiRunResult, type Category, type GoalEntry, type GoalProgress, type InvestmentTransaction, type CategoryUsage, type ImportOutcome, type MonthSummary, type RuleDetail, type RuleInput, type SubscriptionList, type TransactionDetail, type TransactionFilter, type ReviewRow, type SuspectPair, type TransactionRow } from "@jatoba/core";
import type { BackupStatus } from "./scheduler.js";
import { ICON_SVG } from "./icone.js";
import { goalsPage, homePage, subscriptionsPage, transactionPage, importPage, loginPage, monthPage, reviewPage, settingsPage, transactionsPage } from "./pages.js";

export const SESSION_COOKIE = "jatoba_sessao";
const PAGE_SIZE = 50;

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
    list: (opts?: { limit?: number; offset?: number; filter?: TransactionFilter }) => Promise<TransactionRow[]>;
    count: (filter?: TransactionFilter) => Promise<number>;
  };
  /** IA para sugerir categorias (opcional). */
  ai?: {
    status: () => { enabled: boolean; reason?: string };
    run: () => Promise<AiRunResult>;
  };
  backups: {
    status: () => Promise<BackupStatus>;
    /** Backup manual agora; devolve o nome do arquivo. */
    runNow: () => Promise<string>;
  };
  transaction: {
    get: (id: string) => Promise<TransactionDetail | undefined>;
    reopen: (id: string) => Promise<void>;
  };
  subscriptions: {
    list: () => Promise<SubscriptionList>;
    ignore: (key: string, name: string) => Promise<void>;
    unignore: (key: string) => Promise<void>;
  };
  goals: {
    /** Data de hoje (AAAA-MM-DD) no fuso de quem usa. */
    today: () => string;
    list: (opts?: { archived?: boolean }) => Promise<GoalProgress[]>;
    entries: (goalId: number) => Promise<GoalEntry[]>;
    investments: () => Promise<InvestmentTransaction[]>;
    create: (input: { name: string; target: string; deadline: string; saved: string }) => Promise<number>;
    update: (id: number, input: { name: string; target: string; deadline: string }) => Promise<void>;
    setArchived: (id: number, archived: boolean) => Promise<void>;
    delete: (id: number) => Promise<void>;
    addEntry: (goalId: number, input: { kind: string; amount: string; date: string; note: string }) => Promise<void>;
    deleteEntry: (entryId: string) => Promise<void>;
    assign: (transactionId: string, goalId: number) => Promise<void>;
  };
  settings: {
    categories: () => Promise<CategoryUsage[]>;
    rules: () => Promise<RuleDetail[]>;
    accounts: () => Promise<AccountInfo[]>;
    createCategory: (input: { name: string; kind: string }) => Promise<number>;
    updateCategory: (id: number, input: { name: string; kind: string }) => Promise<void>;
    deleteCategory: (id: number, opts: { moveTo?: number }) => Promise<number>;
    createRule: (input: RuleInput) => Promise<number>;
    updateRule: (id: number, input: RuleInput) => Promise<number>;
    deleteRule: (id: number) => Promise<number>;
    renameAccount: (id: number, name: string) => Promise<void>;
  };
  month: {
    months: () => Promise<string[]>;
    summary: (month: string) => Promise<MonthSummary>;
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
        // O app não usa JavaScript no navegador (o menu do celular é só CSS).
        scriptSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
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

  // Ícone (público: aparece na aba do navegador e na tela de entrar).
  app.get("/icone.svg", (c) => {
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(ICON_SVG);
  });

  app.get("/health", async (c) => {
    const database = await deps.checkDatabase();
    return c.json({ status: database ? "ok" : "erro", database: database ? "ok" : "fora do ar", version: deps.version }, database ? 200 : 503);
  });

  /** "ok": sessão válida; "expirou": havia cookie, mas a sessão acabou; "nenhuma": sem cookie. */
  const sessionState = async (c: Context): Promise<"ok" | "expirou" | "nenhuma"> => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token === undefined) return "nenhuma";
    return (await deps.sessions.touch(token)) ? "ok" : "expirou";
  };

  app.get("/entrar", async (c) => {
    if ((await sessionState(c)) === "ok") return c.redirect("/", 303);
    const notice = c.req.query("expirou") !== undefined ? "Sua sessão expirou. Entre de novo." : undefined;
    return c.html(loginPage(undefined, notice));
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
    const expiresAt = await deps.sessions.create(token);
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
    const state = await sessionState(c);
    if (state !== "ok") {
      if (state === "expirou") deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookie });
      if (c.req.method !== "GET") return c.text(state === "expirou" ? "Sua sessão expirou. Faça login de novo." : "Faça login.", 401);
      return c.redirect(state === "expirou" ? "/entrar?expirou" : "/entrar", 303);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/", async (c) => {
    const [count, review, suspects, backup] = await Promise.all([deps.ledger.count(), deps.review.list({ limit: 1 }), deps.review.suspects(), deps.backups.status()]);
    const lastDays = backup.last ? Math.floor((Date.now() - backup.last.date.getTime()) / (24 * 60 * 60_000)) : undefined;
    return c.html(homePage(deps.version, count, review.total + suspects.length, { configured: backup.configured, lastDays }));
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
    // Filtros opcionais: ?mes=AAAA-MM e ?categoria=<id>|sem (vindos da tela do Mês).
    const filter: TransactionFilter = {};
    const mes = c.req.query("mes");
    if (mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) filter.month = `${mes}-01`;
    const categoria = c.req.query("categoria");
    if (categoria === "sem") filter.category = "sem";
    else if (categoria && /^\d{1,9}$/.test(categoria)) filter.category = Number(categoria);
    const categoryName =
      filter.category === "sem" ? "Sem categoria" : typeof filter.category === "number" ? (await deps.review.categories()).find((x) => x.id === filter.category)?.name : undefined;
    const query = [filter.month ? `mes=${mes}` : "", filter.category !== undefined ? `categoria=${filter.category}` : ""].filter(Boolean).map((q) => `${q}&amp;`).join("");

    const total = await deps.ledger.count(filter);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const requested = Number.parseInt(c.req.query("pagina") ?? "1", 10);
    const page = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), pages) : 1;
    const rows = await deps.ledger.list({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, filter });
    const months = await deps.month.months();
    const categoryParam = filter.category === undefined ? undefined : String(filter.category);
    return c.html(transactionsPage(rows, total, { page, pages, pageSize: PAGE_SIZE }, { month: filter.month, categoryName, query, months, categoryParam }));
  });

  app.get("/mes", async (c) => {
    const months = await deps.month.months();
    if (months.length === 0) return c.html(monthPage(undefined, months));
    const asked = c.req.query("m");
    const valid = asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? `${asked}-01` : undefined;
    // Sem mês pedido, ou pedido sem dados: o mais recente com lançamentos.
    const month = valid && months.includes(valid) ? valid : months[0]!;
    return c.html(monthPage(await deps.month.summary(month), months));
  });

  const showReview = async (c: Context, flash: { message?: string; error?: string } = {}, status: 200 | 400 = 200) => {
    const [list, categories, suspects] = await Promise.all([deps.review.list({ limit: 50 }), deps.review.categories(), deps.review.suspects()]);
    return c.html(reviewPage({ ...list, categories, suspects, ai: deps.ai?.status(), ...flash }), status);
  };

  app.get("/revisar", (c) => {
    const outros = Number(c.req.query("outros") ?? 0);
    const duplicado = c.req.query("duplicado");
    const lote = c.req.query("lote");
    const regras = Number(c.req.query("regras") ?? 0);
    const ia = c.req.query("ia");
    let message: string | undefined;
    if (ia !== undefined) {
      const naoSoube = Number(c.req.query("ia_nao") ?? 0);
      message = `A IA sugeriu categoria para ${Number(ia) || 0} lançamento(s)${naoSoube > 0 ? `; em ${naoSoube} estabelecimento(s) ela preferiu não chutar` : ""}. Confira antes de salvar.`;
    } else if (lote !== undefined) {
      const n = Number(lote) || 0;
      message = `${n} lançamento(s) salvo(s)${regras > 0 ? `, ${regras} regra(s) criada(s)` : ""}${outros > 0 ? `; ${outros} outro(s) ganharam sugestão` : ""}.`;
    } else if (duplicado === "descartado") message = "Duplicado descartado. Ele não aparece mais e não volta em novas importações.";
    else if (duplicado === "mantido") message = "Mantidos os dois lançamentos.";
    return showReview(c, { message });
  });

  /**
   * Formulário da página inteira. Com "so=<id>", grava só aquele; com "acao=todos", grava todos os que
   * têm categoria selecionada. Se a escolha é a própria sugestão e não há regra, só aprova (mantém a origem).
   */
  app.post("/revisar/lote", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const form = await c.req.parseBody({ all: true });
    const one = (key: string) => {
      const v = form[key];
      return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
    };
    const rawIds = form.id;
    const ids = (Array.isArray(rawIds) ? rawIds : rawIds === undefined ? [] : [rawIds]).filter(
      (v): v is string => typeof v === "string" && /^\d{1,18}$/.test(v),
    );
    const only = one("so");
    const targets = only ? ids.filter((id) => id === only) : ids;

    let saved = 0;
    let approved = 0;
    let rules = 0;
    let others = 0;
    const toApprove: string[] = [];
    try {
      for (const id of targets) {
        const choice = Number(one(`categoria_${id}`));
        if (!Number.isSafeInteger(choice) || choice <= 0) continue; // sem escolha: fica para depois
        const wantsRule = one(`criar_regra_${id}`) === "1";
        if (!wantsRule && String(choice) === one(`sugestao_${id}`)) {
          toApprove.push(id);
          continue;
        }
        const result = await deps.review.setCategory(id, choice, wantsRule ? { rulePattern: one(`regra_${id}`) } : {});
        saved++;
        if (result.ruleCreated) rules++;
        others += result.otherChanged;
      }
      if (toApprove.length) approved = await deps.review.approve(toApprove);
    } catch (error) {
      if (error instanceof CategoryError) return showReview(c, { error: `${error.message} (${saved + approved} já foram salvos)` }, 400);
      throw error;
    }
    if (only && saved + approved === 0) return showReview(c, { error: "Escolha uma categoria." }, 400);
    return c.redirect(`/revisar?lote=${saved + approved}&regras=${rules}&outros=${others}`, 303);
  });

  app.post("/revisar/ia", bodyLimit({ maxSize: 1024 }), async (c) => {
    if (!deps.ai?.status().enabled) return showReview(c, { error: "A IA não está ligada (AI_PROVIDER e ANTHROPIC_API_KEY no .env)." }, 400);
    try {
      const r = await deps.ai.run();
      return c.redirect(`/revisar?ia=${r.suggested}&ia_nao=${r.unknown}`, 303);
    } catch (error) {
      return showReview(c, { error: `A IA não respondeu: ${(error as Error).message}` }, 400);
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

  // ---------- Um lançamento ----------
  const showTransaction = async (c: Context, id: string, flash: { message?: string; error?: string } = {}, status: 200 | 400 = 200) => {
    const t = await deps.transaction.get(id);
    if (!t) return c.text("Lançamento não encontrado.", 404);
    return c.html(transactionPage({ t, categories: await deps.review.categories(), ...flash }), status);
  };

  app.get("/lancamentos/:id", (c) => {
    const ok = c.req.query("ok");
    const outros = Number(c.req.query("outros") ?? 0);
    const message =
      ok === "salvo" ? "Categoria salva." :
      ok === "regra" ? `Categoria salva e regra criada${outros > 0 ? `; ${outros} outro(s) lançamento(s) ganharam sugestão` : ""}.` :
      ok === "revisar" ? "Voltou para a revisão, com a sugestão automática." : undefined;
    return showTransaction(c, c.req.param("id"), { message });
  });

  app.post("/lancamentos/:id", bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!/^\d{1,18}$/.test(id)) return c.text("Lançamento inválido.", 404);
    const form = await c.req.parseBody();
    const categoryId = Number(form.categoria);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return showTransaction(c, id, { error: "Escolha uma categoria." }, 400);
    const wantsRule = form.criar_regra === "1";
    try {
      const result = await deps.review.setCategory(id, categoryId, wantsRule ? { rulePattern: typeof form.regra === "string" ? form.regra : "" } : {});
      return c.redirect(`/lancamentos/${id}?ok=${result.ruleCreated ? "regra" : "salvo"}&outros=${result.otherChanged}`, 303);
    } catch (error) {
      if (error instanceof CategoryError) return showTransaction(c, id, { error: error.message }, 400);
      throw error;
    }
  });

  app.post("/lancamentos/:id/revisar", bodyLimit({ maxSize: 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!/^\d{1,18}$/.test(id)) return c.text("Lançamento inválido.", 404);
    if (!(await deps.transaction.get(id))) return c.text("Lançamento não encontrado.", 404);
    await deps.transaction.reopen(id);
    return c.redirect(`/lancamentos/${id}?ok=revisar`, 303);
  });

  // ---------- Assinaturas ----------
  app.get("/assinaturas", async (c) => {
    const ok = c.req.query("ok");
    const message = ok === "ignorada" ? "Marcada como “não é assinatura”." : ok === "voltou" ? "Voltou a aparecer na lista." : undefined;
    return c.html(subscriptionsPage({ list: await deps.subscriptions.list(), today: deps.goals.today(), message }));
  });
  const subscriptionKey = (form: Record<string, string | File>) => {
    const key = typeof form.chave === "string" ? form.chave.trim() : "";
    return /^[A-Z ]{3,120}$/.test(key) ? key : undefined;
  };
  app.post("/assinaturas/ignorar", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const form = await c.req.parseBody();
    const key = subscriptionKey(form);
    if (!key) return c.text("Assinatura inválida.", 400);
    await deps.subscriptions.ignore(key, typeof form.nome === "string" ? form.nome : key);
    return c.redirect("/assinaturas?ok=ignorada", 303);
  });
  app.post("/assinaturas/voltar", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const key = subscriptionKey(await c.req.parseBody());
    if (!key) return c.text("Assinatura inválida.", 400);
    await deps.subscriptions.unignore(key);
    return c.redirect("/assinaturas?ok=voltou", 303);
  });

  // ---------- Metas ----------
  const GOAL_MESSAGES: Record<string, string> = {
    criada: "Meta criada.",
    salva: "Meta salva.",
    registrado: "Registrado.",
    apagado: "Registro apagado.",
    ligado: "Lançamento ligado à meta.",
    arquivada: "Meta arquivada.",
    reativada: "Meta reativada.",
    "meta-apagada": "Meta apagada.",
  };

  const showGoals = async (c: Context, flash: { message?: string; error?: string } = {}, status: 200 | 400 = 200) => {
    const [goals, archived, investments] = await Promise.all([deps.goals.list(), deps.goals.list({ archived: true }), deps.goals.investments()]);
    const entries: Record<number, GoalEntry[]> = {};
    await Promise.all(goals.map(async (g) => (entries[g.id] = await deps.goals.entries(g.id))));
    return c.html(goalsPage({ goals, archived, investments, entries, today: deps.goals.today(), ...flash }), status);
  };

  app.get("/metas", (c) => showGoals(c, { message: GOAL_MESSAGES[c.req.query("ok") ?? ""] }));

  const goalAction = (handler: (c: Context, form: Record<string, string | File>) => Promise<string>) =>
    async (c: Context) => {
      const form = await c.req.parseBody();
      try {
        return c.redirect(`/metas?ok=${await handler(c, form)}`, 303);
      } catch (error) {
        if (error instanceof GoalError) return showGoals(c, { error: error.message }, 400);
        throw error;
      }
    };
  const goalId = (c: Context): number => {
    const raw = c.req.param("id") ?? "";
    if (!/^\d{1,9}$/.test(raw)) throw new GoalError("Meta inválida.");
    return Number(raw);
  };
  const bigId = (c: Context): string => {
    const raw = c.req.param("id") ?? "";
    if (!/^\d{1,18}$/.test(raw)) throw new GoalError("Item inválido.");
    return raw;
  };
  const field = (form: Record<string, string | File>, key: string) => (typeof form[key] === "string" ? (form[key] as string) : "");
  const small = bodyLimit({ maxSize: 8 * 1024 });

  app.post("/metas", small, goalAction(async (_c, form) => {
    await deps.goals.create({ name: field(form, "nome"), target: field(form, "alvo"), deadline: field(form, "prazo"), saved: field(form, "guardado") });
    return "criada";
  }));
  app.post("/metas/ligar/:id", small, goalAction(async (c, form) => {
    const meta = field(form, "meta");
    if (!/^\d{1,9}$/.test(meta)) throw new GoalError("Escolha uma meta.");
    await deps.goals.assign(bigId(c), Number(meta));
    return "ligado";
  }));
  app.post("/metas/registros/:id/apagar", small, goalAction(async (c) => {
    await deps.goals.deleteEntry(bigId(c));
    return "apagado";
  }));
  app.post("/metas/:id", small, goalAction(async (c, form) => {
    await deps.goals.update(goalId(c), { name: field(form, "nome"), target: field(form, "alvo"), deadline: field(form, "prazo") });
    return "salva";
  }));
  app.post("/metas/:id/registros", small, goalAction(async (c, form) => {
    await deps.goals.addEntry(goalId(c), { kind: field(form, "tipo"), amount: field(form, "valor"), date: field(form, "data"), note: field(form, "nota") });
    return "registrado";
  }));
  app.post("/metas/:id/arquivar", small, goalAction(async (c, form) => {
    const archive = field(form, "arquivar") !== "0";
    await deps.goals.setArchived(goalId(c), archive);
    return archive ? "arquivada" : "reativada";
  }));
  app.post("/metas/:id/apagar", small, goalAction(async (c, form) => {
    if (field(form, "confirmar") !== "1") throw new GoalError("Marque a confirmação para apagar a meta.");
    await deps.goals.delete(goalId(c));
    return "meta-apagada";
  }));


  // ---------- Ajustes ----------
  const SETTINGS_MESSAGES: Record<string, string> = {
    "categoria-criada": "Categoria criada.",
    "categoria-salva": "Categoria salva.",
    "categoria-apagada": "Categoria apagada.",
    "regra-criada": "Regra criada.",
    "regra-salva": "Regra salva.",
    "regra-apagada": "Regra apagada.",
    "conta-salva": "Conta renomeada.",
    "backup-feito": "Backup criado.",
  };

  const showSettings = async (c: Context, flash: { message?: string; error?: string } = {}, status: 200 | 400 = 200) => {
    const [categories, rules, accounts, backup] = await Promise.all([deps.settings.categories(), deps.settings.rules(), deps.settings.accounts(), deps.backups.status()]);
    return c.html(settingsPage({ categories, rules, accounts, backup, ...flash }), status);
  };

  app.get("/ajustes", (c) => {
    const key = c.req.query("ok") ?? "";
    const n = Number(c.req.query("n") ?? 0);
    const base = SETTINGS_MESSAGES[key];
    const message = base ? `${base}${n > 0 ? ` ${n} lançamento(s) mudaram de sugestão ou de categoria.` : ""}` : undefined;
    return showSettings(c, { message });
  });

  /** Executa uma ação dos Ajustes; erros de validação voltam para a página com a mensagem. */
  const settingsAction = (handler: (c: Context, form: Record<string, string | File>) => Promise<string>) =>
    async (c: Context) => {
      const form = await c.req.parseBody();
      try {
        return c.redirect(await handler(c, form), 303);
      } catch (error) {
        if (error instanceof CategoryError) return showSettings(c, { error: error.message }, 400);
        throw error;
      }
    };
  const idParam = (c: Context): number => {
    const raw = c.req.param("id") ?? "";
    if (!/^\d{1,9}$/.test(raw)) throw new CategoryError("Item inválido.");
    return Number(raw);
  };
  const text = (form: Record<string, string | File>, key: string) => (typeof form[key] === "string" ? (form[key] as string) : "");
  const ruleInput = (form: Record<string, string | File>) => ({
    pattern: text(form, "texto"),
    direction: text(form, "direcao"),
    accountKind: text(form, "conta"),
    categoryId: Number(text(form, "categoria")) || 0,
  });
  const limit = bodyLimit({ maxSize: 8 * 1024 });

  app.post("/ajustes/categorias", limit, settingsAction(async (_c, form) => {
    await deps.settings.createCategory({ name: text(form, "nome"), kind: text(form, "tipo") });
    return "/ajustes?ok=categoria-criada";
  }));
  app.post("/ajustes/categorias/:id", limit, settingsAction(async (c, form) => {
    await deps.settings.updateCategory(idParam(c), { name: text(form, "nome"), kind: text(form, "tipo") });
    return "/ajustes?ok=categoria-salva";
  }));
  app.post("/ajustes/categorias/:id/apagar", limit, settingsAction(async (c, form) => {
    if (text(form, "confirmar") !== "1") throw new CategoryError("Marque a confirmação para apagar a categoria.");
    const target = text(form, "mover_para");
    const moveTo = /^\d{1,9}$/.test(target) ? Number(target) : undefined;
    const n = await deps.settings.deleteCategory(idParam(c), moveTo === undefined ? {} : { moveTo });
    return `/ajustes?ok=categoria-apagada&n=${n}`;
  }));
  app.post("/ajustes/regras", limit, settingsAction(async (_c, form) => {
    const n = await deps.settings.createRule(ruleInput(form));
    return `/ajustes?ok=regra-criada&n=${n}`;
  }));
  app.post("/ajustes/regras/:id", limit, settingsAction(async (c, form) => {
    const n = await deps.settings.updateRule(idParam(c), ruleInput(form));
    return `/ajustes?ok=regra-salva&n=${n}`;
  }));
  app.post("/ajustes/regras/:id/apagar", limit, settingsAction(async (c) => {
    const n = await deps.settings.deleteRule(idParam(c));
    return `/ajustes?ok=regra-apagada&n=${n}`;
  }));
  app.post("/ajustes/backup", bodyLimit({ maxSize: 1024 }), async (c) => {
    try {
      await deps.backups.runNow();
    } catch (error) {
      return showSettings(c, { error: `O backup falhou: ${(error as Error).message}` }, 400);
    }
    return c.redirect("/ajustes?ok=backup-feito", 303);
  });
  app.post("/ajustes/contas/:id", limit, settingsAction(async (c, form) => {
    await deps.settings.renameAccount(idParam(c), text(form, "nome"));
    return "/ajustes?ok=conta-salva";
  }));

  return app;
}
