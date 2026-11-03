import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { basename } from "node:path";
import {
  ConfigError,
  MigrationError,
  approveSuggestions,
  categorize,
  listCategories,
  listForReview,
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

const app = createApp({
  version: VERSION,
  credentials: await Credentials.create(config.JATOBA_ADMIN_USER, config.JATOBA_ADMIN_PASSWORD),
  sessions,
  limiter: new LoginLimiter(),
  publicUrl: config.JATOBA_PUBLIC_URL,
  checkDatabase: () => isDatabaseUp(sql),
  clientKey: (c) => getConnInfo(c).remote.address ?? "desconhecido",
  ledger: {
    importFile: (fileName, bytes) => importFile(sql, fileName, bytes),
    list: (opts) => listTransactions(sql, opts),
    count: (filter) => countTransactions(sql, filter),
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
  server.close();
  void sql.end({ timeout: 5 }).finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
