import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ConfigError, loadConfig, type Config } from "@jatoba/core";
import { homePage } from "./pages.js";
import { VERSION } from "./version.js";

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error("Corrija o .env e rode novamente: docker compose up -d");
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const app = new Hono();

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

app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));
app.get("/", (c) => c.html(homePage(VERSION)));

// Dentro do contêiner escuta em todas as interfaces; quem limita o acesso
// ao próprio computador é o mapeamento 127.0.0.1 do compose.yaml.
serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Jatobá Finance ${VERSION} pronto na porta ${info.port}`);
});
