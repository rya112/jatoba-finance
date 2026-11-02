import { describe, expect, it } from "vitest";
import { ConfigError, EXAMPLE_PASSWORD, loadConfig } from "../src/config.js";

const base = {
  JATOBA_ADMIN_USER: "ricardo",
  JATOBA_ADMIN_PASSWORD: "uma-frase-bem-longa-de-teste",
  DATABASE_URL: "postgres://jatoba:abc123@postgres:5432/jatoba",
};

describe("loadConfig", () => {
  it("aceita a configuração mínima e aplica os padrões", () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(8080);
    expect(config.AI_PROVIDER).toBe("none");
    expect(config.JATOBA_CURRENCY).toBe("BRL");
    expect(config.telegramAllowedChatIds).toEqual([]);
  });

  it("recusa a senha do exemplo", () => {
    expect(() => loadConfig({ ...base, JATOBA_ADMIN_PASSWORD: EXAMPLE_PASSWORD })).toThrow(/senha do exemplo/);
  });

  it("recusa senha curta", () => {
    expect(() => loadConfig({ ...base, JATOBA_ADMIN_PASSWORD: "curta" })).toThrow(ConfigError);
  });

  it("recusa configuração sem usuário", () => {
    expect(() => loadConfig({ ...base, JATOBA_ADMIN_USER: "" })).toThrow(/JATOBA_ADMIN_USER/);
  });

  it("exige a chave quando a IA da Anthropic está ligada", () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("exige os chat IDs quando o bot está ligado", () => {
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123:abc" })).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
  });

  it("lê a lista de chat IDs", () => {
    const config = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_CHAT_IDS: "111, 222" });
    expect(config.telegramAllowedChatIds).toEqual([111, 222]);
  });

  it("trata variáveis vazias como ausentes", () => {
    const config = loadConfig({ ...base, ANTHROPIC_API_KEY: "", AI_PROVIDER: "" });
    expect(config.AI_PROVIDER).toBe("none");
  });
});
