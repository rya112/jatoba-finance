import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { basename } from "node:path";
import {
  AiError,
  ConfigError,
  MigrationError,
  estimateCostUsd,
  suggestWithAi,
  type AiRunResult,
  approveSuggestions,
  categorize,
  listCategories,
  listForReview,
  getTransaction,
  reopenReview,
  listSubscriptions,
  ignoreSubscription,
  unignoreSubscription,
  listGoals,
  listGoalEntries,
  listUnassignedInvestments,
  createGoal,
  updateGoal,
  setGoalArchived,
  deleteGoal,
  addGoalEntry,
  deleteGoalEntry,
  assignTransaction,
  listCategoryUsage,
  listRuleDetails,
  listAccounts,
  createCategory,
  updateCategory,
  deleteCategory,
  createRule,
  updateRule,
  deleteRule,
  renameAccount,
  listMonths,
  monthSummary,
  listSuspects,
  resolveSuspect,
  setCategory,
  connect,
  countTransactions,
  importFile,
  isDatabaseUp,
  listTransactions,
  loadConfig,
  migrate,
  pendingMigrations,
  waitForDatabase,
  type Config,
} from "@jatoba/core";
import { createBackup } from "./backup.js";
import { backupStatus, startScheduler } from "./scheduler.js";
import { createResponder } from "./bot-commands.js";
import { TelegramBot, tg } from "./telegram.js";
import { createApp } from "./app.js";
import { Credentials, LoginLimiter, PgSessionStore } from "./auth.js";
import { VERSION } from "./version.js";

function fail(message: string, hint: string): never {
  console.error(message);
  console.error(hint);
  process.exit(1);
}

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message, "Corrija o .env e rode novamente: docker compose up -d");
    throw error;
  }
}

const config = readConfig();
const sql = connect(config.DATABASE_URL);

try {
  await waitForDatabase(sql);
} catch (error) {
  fail(`Não consegui conectar ao banco de dados: ${(error as Error).message}`, "Confira se o Postgres está no ar: docker compose ps");
}

// Antes de mudar a estrutura de um banco com dados, faz um backup automático.
const { pending, hasData } = await pendingMigrations(sql);
if (pending.length > 0 && hasData) {
  if (config.JATOBA_BACKUP_RECIPIENT) {
    try {
      const file = await createBackup({
        databaseUrl: config.DATABASE_URL,
        recipient: config.JATOBA_BACKUP_RECIPIENT,
        dir: config.JATOBA_BACKUP_DIR,
        reason: "antes-migracao",
      });
      console.log(`Backup antes das migrações: ${basename(file)}`);
    } catch (error) {
      fail(
        `Há migrações a aplicar, mas o backup automático falhou: ${(error as Error).message}`,
        "Nada foi alterado. Resolva o problema do backup e rode novamente: docker compose up -d",
      );
    }
  } else {
    console.warn("Aviso: há migrações a aplicar e JATOBA_BACKUP_RECIPIENT não está no .env, então não houve backup automático.");
  }
}

try {
  const applied = await migrate(sql);
  for (const id of applied) console.log(`Migração aplicada: ${id}`);
} catch (error) {
  if (error instanceof MigrationError) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    fail(`${error.message}${cause}`, "A aplicação não vai subir até isso ser resolvido. Veja docs/atualizar.md.");
  }
  throw error;
}

// Aplica descrições limpas e sugestões de categoria (também a lançamentos antigos, se as regras mudaram).
const suggested = await categorize(sql);
if (suggested > 0) console.log(`Sugestões de categoria atualizadas: ${suggested}`);

const sessions = new PgSessionStore(sql);
await sessions.purgeExpired();
setInterval(() => void sessions.purgeExpired().catch(() => {}), 6 * 60 * 60_000).unref();

/** Hoje no fuso configurado (TZ do .env), em AAAA-MM-DD. */
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const today = () => dayFormat.format(new Date());

const backupConfig = {
  dir: config.JATOBA_BACKUP_DIR,
  daily: config.JATOBA_BACKUP_DAILY === "true",
  hour: config.JATOBA_BACKUP_HOUR,
  keep: config.JATOBA_BACKUP_KEEP,
};
// ---------- IA para sugerir categorias (opcional: AI_PROVIDER=anthropic + ANTHROPIC_API_KEY) ----------
let aiDisabledReason: string | undefined;
let aiRunning: Promise<AiRunResult> | undefined;
const aiClient = config.AI_PROVIDER === "anthropic" && config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 }) : undefined;
if (config.AI_PROVIDER === "ollama") aiDisabledReason = "o Ollama ainda não é suportado; use AI_PROVIDER=anthropic.";
/** Uma execução por vez; quem chega enquanto roda espera a mesma. */
const runAi = (): Promise<AiRunResult> => {
  if (!aiClient || aiDisabledReason) return Promise.reject(new Error(aiDisabledReason ?? "IA desligada."));
  aiRunning ??= suggestWithAi(sql, aiClient, { model: config.ANTHROPIC_MODEL, log: (m) => console.log(m) })
    .then((r) => {
      if (r.asked || r.suggested) {
        console.log(`IA: ${r.asked} estabelecimento(s) consultado(s), ${r.suggested} lançamento(s) com sugestão, ${r.unknown} sem resposta; custo aproximado US$ ${estimateCostUsd(r).toFixed(4)}.`);
      }
      return r;
    })
    .catch((error: unknown) => {
      if (error instanceof AiError) {
        aiDisabledReason = error.message;
        console.warn(`IA desligada: ${error.message}`);
      }
      throw error;
    })
    .finally(() => {
      aiRunning = undefined;
    });
  return aiRunning;
};
/** Em segundo plano (depois de importar e ao subir): erros só vão para o log. */
const runAiInBackground = () => {
  if (aiClient && !aiDisabledReason) void runAi().catch(() => {});
};
if (aiClient) {
  console.log(`IA ligada: ${config.ANTHROPIC_MODEL} para sugerir categorias dos lançamentos sem sugestão.`);
  setTimeout(runAiInBackground, 5_000).unref();
}

// ---------- Bot do Telegram (opcional: só com TELEGRAM_BOT_TOKEN no .env) ----------
let bot: TelegramBot | undefined;
if (config.TELEGRAM_BOT_TOKEN) {
  const respond = createResponder({
    botName: config.BOT_NAME,
    timeZone: config.TZ,
    publicUrl: config.JATOBA_PUBLIC_URL,
    months: () => listMonths(sql, config.JATOBA_CURRENCY),
    month: (m) => monthSummary(sql, m, config.JATOBA_CURRENCY),
    goals: () => listGoals(sql, today()),
    review: async () => ({ pending: (await listForReview(sql, { limit: 1 })).total, suspects: (await listSuspects(sql)).length }),
    subscriptions: () => listSubscriptions(sql, today(), config.JATOBA_CURRENCY),
    backup: () => backupStatus({ ...backupConfig, configured: Boolean(config.JATOBA_BACKUP_RECIPIENT) }),
  });
  bot = new TelegramBot({ token: config.TELEGRAM_BOT_TOKEN, allowedChatIds: config.telegramAllowedChatIds, respond });
  bot.start();
  console.log(`Bot do Telegram ligado (${config.telegramAllowedChatIds.length} chat(s) autorizado(s)).`);
}

const scheduler = startScheduler({
  ...backupConfig,
  databaseUrl: config.DATABASE_URL,
  recipient: config.JATOBA_BACKUP_RECIPIENT,
  timeZone: config.TZ,
  log: (message) => {
    console.log(message);
    if (message.startsWith("Backup diário falhou")) void bot?.notify(`⚠️ ${tg(message)}`);
  },
});
if (backupConfig.daily && config.JATOBA_BACKUP_RECIPIENT) {
  console.log(`Backup diário ligado: a partir das ${backupConfig.hour}h (${config.TZ}), guardando ${backupConfig.keep}.`);
} else if (!config.JATOBA_BACKUP_RECIPIENT) {
  console.warn("Aviso: JATOBA_BACKUP_RECIPIENT não está no .env; não há backup automático.");
}

const app = createApp({
  version: VERSION,
  credentials: await Credentials.create(config.JATOBA_ADMIN_USER, config.JATOBA_ADMIN_PASSWORD),
  sessions,
  limiter: new LoginLimiter(),
  publicUrl: config.JATOBA_PUBLIC_URL,
  checkDatabase: () => isDatabaseUp(sql),
  clientKey: (c) => getConnInfo(c).remote.address ?? "desconhecido",
  ledger: {
    importFile: async (fileName, bytes) => {
      const outcome = await importFile(sql, fileName, bytes);
      runAiInBackground();
      const inserted = outcome.statements.reduce((n, s) => n + s.inserted, 0);
      const suspects = outcome.statements.reduce((n, s) => n + s.suspects, 0);
      if (bot && inserted > 0) {
        const pending = (await listForReview(sql, { limit: 1 })).total;
        void bot.notify(
          `Importado <b>${tg(fileName)}</b>: ${inserted} novo(s).` +
            (pending ? ` ${pending} para revisar.` : "") +
            (suspects ? ` ${suspects} possível(is) duplicado(s).` : ""),
        );
      }
      return outcome;
    },
    list: (opts) => listTransactions(sql, opts),
    count: (filter) => countTransactions(sql, filter),
  },
  ai: aiClient
    ? { status: () => ({ enabled: !aiDisabledReason, reason: aiDisabledReason }), run: runAi }
    : aiDisabledReason
      ? { status: () => ({ enabled: false, reason: aiDisabledReason }), run: runAi }
      : undefined,
  backups: {
    status: () => backupStatus({ ...backupConfig, configured: Boolean(config.JATOBA_BACKUP_RECIPIENT) }),
    runNow: async () => {
      if (!config.JATOBA_BACKUP_RECIPIENT) throw new Error("JATOBA_BACKUP_RECIPIENT não está no .env (veja docs/backup.md).");
      const file = await createBackup({ databaseUrl: config.DATABASE_URL, recipient: config.JATOBA_BACKUP_RECIPIENT, dir: config.JATOBA_BACKUP_DIR, reason: "manual" });
      return basename(file);
    },
  },
  transaction: {
    get: (id) => getTransaction(sql, id),
    reopen: (id) => reopenReview(sql, id),
  },
  subscriptions: {
    list: () => listSubscriptions(sql, today(), config.JATOBA_CURRENCY),
    ignore: (key, name) => ignoreSubscription(sql, key, name),
    unignore: (key) => unignoreSubscription(sql, key),
  },
  goals: {
    today,
    list: (opts) => listGoals(sql, today(), opts),
    entries: (goalId) => listGoalEntries(sql, goalId),
    investments: () => listUnassignedInvestments(sql),
    create: (input) => createGoal(sql, input, today()),
    update: (id, input) => updateGoal(sql, id, input),
    setArchived: (id, archived) => setGoalArchived(sql, id, archived),
    delete: (id) => deleteGoal(sql, id),
    addEntry: (goalId, input) => addGoalEntry(sql, goalId, input),
    deleteEntry: (id) => deleteGoalEntry(sql, id),
    assign: (transactionId, goalId) => assignTransaction(sql, transactionId, goalId),
  },
  settings: {
    categories: () => listCategoryUsage(sql),
    rules: () => listRuleDetails(sql),
    accounts: () => listAccounts(sql),
    createCategory: (input) => createCategory(sql, input),
    updateCategory: (id, input) => updateCategory(sql, id, input),
    deleteCategory: (id, opts) => deleteCategory(sql, id, opts),
    createRule: (input) => createRule(sql, input),
    updateRule: (id, input) => updateRule(sql, id, input),
    deleteRule: (id) => deleteRule(sql, id),
    renameAccount: (id, name) => renameAccount(sql, id, name),
  },
  month: {
    months: () => listMonths(sql, config.JATOBA_CURRENCY),
    summary: (month) => monthSummary(sql, month, config.JATOBA_CURRENCY),
  },
  review: {
    categories: () => listCategories(sql),
    list: (opts) => listForReview(sql, opts),
    setCategory: (id, categoryId, opts) => setCategory(sql, id, categoryId, opts),
    approve: (ids) => approveSuggestions(sql, ids),
    suspects: () => listSuspects(sql),
    resolve: (id, decision) => resolveSuspect(sql, id, decision),
  },
});

// Dentro do contêiner escuta em todas as interfaces; quem limita o acesso
// ao próprio computador é o mapeamento 127.0.0.1 do compose.yaml.
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Jatobá Finance ${VERSION} pronto na porta ${info.port}`);
});

const shutdown = () => {
  bot?.stop();
  scheduler.stop();
  server.close();
  void sql.end({ timeout: 5 }).finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
