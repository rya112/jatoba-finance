import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiError, aiKey, classifyWithAi, estimateCostUsd, suggestWithAi, systemPrompt, type AiClient } from "../src/ai.js";
import { categorize, listCategories, setCategory, type Category } from "../src/categories.js";
import { connect, type Sql } from "../src/db.js";
import { importFile } from "../src/import/importer.js";
import { migrate } from "../src/migrate.js";
import { freshDatabase, TEST_DATABASE_URL } from "./helpers/database.js";

const CATEGORIES: Category[] = [
  { id: 1, name: "Mercado", kind: "despesa" },
  { id: 2, name: "Transporte", kind: "despesa" },
  { id: 3, name: "Salário", kind: "receita" },
  { id: 4, name: "Transferência entre contas", kind: "movimentacao" },
];

type Answer = { n: number; categoria: string };
type Parse = AiClient["messages"]["parse"];

/** API falsa: registra cada pedido e responde com a função dada (ou lança o erro dado). */
function fakeClient(answer: (lines: string[]) => Answer[] | Error | { stop: string }) {
  const calls: { system: string; content: string; params: Record<string, unknown> }[] = [];
  const parse = (async (params: Record<string, unknown>) => {
    const content = (params.messages as { content: string }[])[0]!.content;
    const system = (params.system as { text: string }[])[0]!.text;
    calls.push({ system, content, params });
    const lines = content.split("\n").slice(1);
    const result = answer(lines);
    if (result instanceof Error) throw result;
    if ("stop" in result) return { stop_reason: result.stop, parsed_output: null, usage: { input_tokens: 10, output_tokens: 0 } };
    return { stop_reason: "end_turn", parsed_output: { itens: result }, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 } };
  }) as unknown as Parse;
  return { client: { messages: { parse } } as AiClient, calls };
}

/** Classifica pela descrição: "MERCADO" → Mercado, "POSTO" → Transporte, "SALARIO" → Salário, o resto → nenhuma. */
const byText = (lines: string[]): Answer[] =>
  lines.map((line, i) => ({
    n: i + 1,
    categoria: /MERCADO|SUPERMERCADO/.test(line) ? "Mercado" : /POSTO/.test(line) ? "Transporte" : /SALARIO/.test(line) ? "Salário" : "nenhuma",
  }));

const item = (i: number, description: string) => ({ key: `K${i}`, description, direction: "saida" as const, accountKind: "conta" as const });

describe("prompt e chave", () => {
  it("o prompt fixo lista as categorias com o tipo e explica quando não chutar", () => {
    const p = systemPrompt(CATEGORIES);
    expect(p).toContain("- Mercado (despesa)");
    expect(p).toContain("- Transferência entre contas (movimentação");
    expect(p).toContain('"nenhuma"');
  });

  it("a chave junta descrição limpa, direção e tipo de conta", () => {
    expect(aiKey("COMPRA CARTAO DEBITO Padaria Exemplo", -1000, "conta")).toBe("PADARIA EXEMPLO|saida|conta");
    expect(aiKey("PIX RECEBIDO FULANO", 500, "conta")).toBe("FULANO|entrada|conta");
  });

  it("custo estimado pelos preços do Haiku 5.5", () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6);
  });
});

describe("classifyWithAi", () => {
  it("manda em lotes de 60, com modelo, effort baixo, cache e formato estruturado", async () => {
    const { client, calls } = fakeClient(byText);
    const items = Array.from({ length: 70 }, (_, i) => item(i, i % 2 ? "MERCADO X" : "PIX FULANO"));
    const r = await classifyWithAi(client, items, CATEGORIES);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.content.split("\n")).toHaveLength(61);
    expect(calls[0]!.params).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect((calls[0]!.params.output_config as { format: unknown }).format).toBeDefined();
    expect((calls[0]!.params.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(r.answers.get("K1")).toBe(1);
    expect(r.answers.get("K0")).toBeNull();
    expect(r.answers.size).toBe(70);
    expect(r.inputTokens).toBe(2000);
  });

  it("ignora números de item que não existem", async () => {
    const { client } = fakeClient(() => [{ n: 1, categoria: "Mercado" }, { n: 99, categoria: "Mercado" }]);
    const r = await classifyWithAi(client, [item(0, "MERCADO")], CATEGORIES);
    expect([...r.answers]).toEqual([["K0", 1]]);
  });

  it("recusa ou resposta cortada: pula o lote, sem inventar", async () => {
    const { client } = fakeClient(() => ({ stop: "refusal" }));
    const r = await classifyWithAi(client, [item(0, "MERCADO")], CATEGORIES);
    expect(r.answers.size).toBe(0);
    expect(r.skippedBatches).toBe(1);
  });

  it("chave recusada vira AiError (que desliga a IA)", async () => {
    const { client } = fakeClient(() => new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", new Headers()));
    await expect(classifyWithAi(client, [item(0, "MERCADO")], CATEGORIES)).rejects.toThrow(AiError);
  });

  it("limite de uso: para e deixa o resto para depois", async () => {
    let n = 0;
    const { client } = fakeClient((lines) => (++n === 2 ? new Anthropic.RateLimitError(429, {}, "rate limited", new Headers()) : byText(lines)));
    const items = Array.from({ length: 130 }, (_, i) => item(i, "MERCADO"));
    const logs: string[] = [];
    const r = await classifyWithAi(client, items, CATEGORIES, { log: (m) => logs.push(m) });
    expect(r.answers.size).toBe(60);
    expect(r.skippedBatches).toBe(2);
    expect(logs[0]).toContain("limite de uso");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("suggestWithAi no Postgres", () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  const categoryOf = async (description: string) =>
    (await sql<{ name: string | null; source: string | null }[]>`
      select c.name, t.category_source as source from transactions t left join categories c on c.id = t.category_id
      where t.description = ${description} order by t.id limit 1`)[0]!;

  beforeAll(async () => {
    const db = await freshDatabase("ai");
    drop = db.drop;
    sql = connect(db.url);
    await migrate(sql);
  });

  beforeEach(async () => {
    await sql`truncate ai_suggestions, transactions, imports, accounts restart identity cascade`;
    await sql`delete from rules where origin = 'usuario'`;
    // O extrato fictício tem lançamentos sem nenhuma sugestão (supermercado no débito, Pix, luz).
    await importFile(sql, "conta.ofx", readFileSync(new URL("./fixtures/banco-exemplo-corrente.ofx", import.meta.url)));
  });

  afterAll(async () => {
    await sql?.end();
    await drop?.();
  });

  it("sugere só para quem não tem sugestão, marca como IA e não manda valores nem datas", async () => {
    const { client, calls } = fakeClient(byText);
    const r = await suggestWithAi(sql, client);
    expect(await categoryOf("COMPRA CARTAO DEBITO SUPERMERCADO EXEMPLO SAO PAULO")).toEqual({ name: "Mercado", source: "ia" });
    expect(await categoryOf("PAGAMENTO FATURA CARTAO EXEMPLO")).toMatchObject({ source: "regra" }); // já tinha regra: não foi para a IA
    expect(calls[0]!.content).not.toContain("FATURA");
    expect(calls[0]!.content).not.toMatch(/312|2026|1\.000|R\$/); // nem valor, nem data
    expect(r.suggested).toBeGreaterThanOrEqual(1);
    expect(r.unknown).toBeGreaterThanOrEqual(1); // Pix para pessoa: a IA prefere não chutar
  });

  it("guarda a resposta: a segunda vez não chama a API", async () => {
    const first = fakeClient(byText);
    await suggestWithAi(sql, first.client);
    const second = fakeClient(byText);
    await suggestWithAi(sql, second.client);
    expect(second.calls).toHaveLength(0);
  });

  it("a reaplicação das regras mantém a sugestão da IA; uma regra do usuário vence", async () => {
    await suggestWithAi(sql, fakeClient(byText).client);
    await categorize(sql);
    expect(await categoryOf("COMPRA CARTAO DEBITO SUPERMERCADO EXEMPLO SAO PAULO")).toEqual({ name: "Mercado", source: "ia" });

    const outros = (await listCategories(sql)).find((c) => c.name === "Outros")!.id;
    const [luz] = await sql<{ id: string }[]>`select id from transactions where description = 'DEB AUTOMATICO ENERGIA EXEMPLO'`;
    await setCategory(sql, luz!.id, outros, { rulePattern: "SUPERMERCADO" });
    expect(await categoryOf("COMPRA CARTAO DEBITO SUPERMERCADO EXEMPLO SAO PAULO")).toMatchObject({ name: "Outros", source: "regra" });
  });

  it("nada para sugerir: não chama a API", async () => {
    await sql`update transactions set reviewed = true`;
    const { client, calls } = fakeClient(byText);
    expect(await suggestWithAi(sql, client)).toMatchObject({ asked: 0, suggested: 0 });
    expect(calls).toHaveLength(0);
  });
});
