import { readFileSync } from "node:fs";
import { z } from "zod";

export const EXAMPLE_PASSWORD = "troque-por-uma-frase-longa-e-unica";
const MIN_PASSWORD_LENGTH = 14;

/** Variáveis que também podem vir de um arquivo (Docker secrets), via <NOME>_FILE. */
const FILE_VARIABLES = [
  "JATOBA_ADMIN_PASSWORD",
  "POSTGRES_PASSWORD",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
] as const;

const schema = z
  .object({
    JATOBA_ADMIN_USER: z
      .string()
      .trim()
      .min(3, "precisa ter pelo menos 3 caracteres"),
    JATOBA_ADMIN_PASSWORD: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`)
      .refine((value) => value !== EXAMPLE_PASSWORD, "ainda é a senha do exemplo; troque no .env"),
    DATABASE_URL: z.url("precisa ser um endereço postgres:// válido"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    JATOBA_PUBLIC_URL: z.url("precisa ser um endereço https:// válido").optional(),
    JATOBA_LOCALE: z.string().default("pt-BR"),
    JATOBA_CURRENCY: z.string().length(3, "use o código de 3 letras, como BRL").default("BRL"),
    TZ: z.string().default("America/Sao_Paulo"),
    AI_PROVIDER: z.enum(["none", "anthropic", "ollama"]).default("none"),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().trim().default("claude-haiku-5-5"),
    OLLAMA_URL: z.url().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
    BOT_NAME: z.string().default("Jatobá"),
    JATOBA_BACKUP_RECIPIENT: z
      .string()
      .trim()
      .regex(/^age1[02-9ac-hj-np-z]{58}$/, "precisa ser uma chave pública do age (começa com age1); gere com: docker compose run --rm --no-deps app jatoba keygen")
      .optional(),
    JATOBA_BACKUP_DIR: z.string().default("/backups"),
    // Backup automático diário (precisa de JATOBA_BACKUP_RECIPIENT).
    JATOBA_BACKUP_DAILY: z.enum(["true", "false"], { message: "use true ou false" }).default("true"),
    JATOBA_BACKUP_HOUR: z.coerce.number().int().min(0, "de 0 a 23").max(23, "de 0 a 23").default(3),
    JATOBA_BACKUP_KEEP: z.coerce.number().int().min(1, "guarde pelo menos 1").max(3650).default(14),
  })
  .superRefine((config, ctx) => {
    if (config.AI_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "obrigatória quando AI_PROVIDER=anthropic" });
    }
    if (config.AI_PROVIDER === "ollama" && !config.OLLAMA_URL) {
      ctx.addIssue({ code: "custom", path: ["OLLAMA_URL"], message: "obrigatória quando AI_PROVIDER=ollama" });
    }
    if (config.TELEGRAM_BOT_TOKEN && !config.TELEGRAM_ALLOWED_CHAT_IDS) {
      ctx.addIssue({
        code: "custom",
        path: ["TELEGRAM_ALLOWED_CHAT_IDS"],
        message: "obrigatória quando o bot está ligado, para ele responder só a você",
      });
    }
  });

export type Config = z.infer<typeof schema> & { telegramAllowedChatIds: number[] };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Lê e valida a configuração. Lança ConfigError com uma mensagem clara se algo estiver errado. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") input[key] = value;
  }

  for (const key of FILE_VARIABLES) {
    const file = input[`${key}_FILE`];
    if (file && !input[key]) {
      try {
        input[key] = readFileSync(file, "utf8").trim();
      } catch {
        throw new ConfigError(`Não consegui ler ${key}_FILE (${file}).`);
      }
    }
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.map(String).join(".") || "configuração"}: ${issue.message}`);
    throw new ConfigError(`Configuração inválida no .env:\n${lines.join("\n")}`);
  }

  const telegramAllowedChatIds = (parsed.data.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map(Number);
  if (telegramAllowedChatIds.some((id) => !Number.isSafeInteger(id))) {
    throw new ConfigError("Configuração inválida no .env:\n  - TELEGRAM_ALLOWED_CHAT_IDS: use números separados por vírgula");
  }

  return { ...parsed.data, telegramAllowedChatIds };
}
