import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ConfigError, MigrationError, connect, isDatabaseUp, loadConfig, migrate, waitForDatabase, type Config } from "@jatoba/core";
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

const sessions = new PgSessionStore(sql);
await sessions.purgeExpired();
setInterval(() => void sessions.purgeExpired().catch(() => {}), 6 * 60 * 60_000).unref();

const app = createApp({
  version: VERSION,
  credentials: await Credentials.create(config.JATOBA_ADMIN_USER, config.JATOBA_ADMIN_PASSWORD),
  sessions,
  limiter: new LoginLimiter(),
  publicUrl: config.JATOBA_PUBLIC_URL,
  checkDatabase: () => isDatabaseUp(sql),
  clientKey: (c) => getConnInfo(c).remote.address ?? "desconhecido",
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
