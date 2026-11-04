import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { cleanDescription, listCategories, normalizeText, type AccountKind, type Category } from "./categories.js";
import type { Sql } from "./db.js";

/**
 * IA para sugerir categorias (opcional, AI_PROVIDER=anthropic).
 *
 * Só vai para a API o que é preciso para classificar: a descrição limpa, se é entrada ou saída e se é
 * conta ou cartão, mais a sua lista de categorias. Valores, datas, contas e nomes de arquivo não vão.
 * Cada estabelecimento é perguntado uma vez: a resposta fica em ai_suggestions.
 * Só entram lançamentos que nenhuma regra, categoria do banco ou estorno classificou. A sugestão da IA
 * é só uma sugestão: vale depois que você aprova na Revisar.
 */

export const DEFAULT_AI_MODEL = "claude-haiku-5-5";
const BATCH = 60;
const NONE = "nenhuma";

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

/** O mínimo do SDK que usamos; nos testes, um falso. */
export interface AiClient {
  messages: Pick<Anthropic["messages"], "parse">;
}

export interface AiItem {
  key: string;
  description: string;
  direction: "saida" | "entrada";
  accountKind: AccountKind;
}

export interface AiRunResult {
  /** Estabelecimentos perguntados à API agora. */
  asked: number;
  /** Lançamentos que ganharam sugestão (da API agora ou do que já estava guardado). */
  suggested: number;
  /** Estabelecimentos para os quais a IA não soube. */
  unknown: number;
  inputTokens: number;
  outputTokens: number;
  skippedBatches: number;
}

/** Chave do estabelecimento para a IA. */
export function aiKey(description: string, amount: number, accountKind: AccountKind): string {
  return `${normalizeText(cleanDescription(description))}|${amount < 0 ? "saida" : "entrada"}|${accountKind}`;
}

const KIND_LABEL: Record<Category["kind"], string> = {
  despesa: "despesa",
  receita: "receita",
  movimentacao: "movimentação entre contas próprias, fatura ou investimento (não é gasto nem receita)",
};

/** Instruções fixas, com a lista de categorias: igual em todas as chamadas, para aproveitar o cache. */
export function systemPrompt(categories: readonly Category[]): string {
  const list = categories.map((c) => `- ${c.name} (${KIND_LABEL[c.kind]})`).join("\n");
  return `Você classifica lançamentos de extratos bancários brasileiros em categorias de finanças pessoais.

Cada item traz a descrição do lançamento como o banco escreveu, se foi saída ou entrada de dinheiro e se é conta corrente ou cartão de crédito. Escolha para cada item exatamente uma categoria da lista abaixo, pelo nome exato.

Categorias:
${list}

Responda "${NONE}" quando a descrição não permitir saber com razoável segurança, por exemplo um Pix para uma pessoa sem outra pista, ou quando nenhuma categoria servir. Errar é pior do que responder "${NONE}": a pessoa revisa cada sugestão.

Use o tipo do lançamento: uma entrada raramente é uma despesa, e uma saída raramente é uma receita. Estornos e reembolsos de compras costumam ser entradas na mesma categoria da compra.`;
}

function itemsSchema(categories: readonly Category[]) {
  const names = categories.map((c) => c.name) as [string, ...string[]];
  return z.object({
    itens: z.array(
      z.object({
        n: z.number().int().describe("Número do item, como veio na lista"),
        categoria: z.enum([...names, NONE]),
      }),
    ),
  });
}

/** Pergunta à API a categoria de cada item. Devolve, por chave, o id da categoria (ou null). */
export async function classifyWithAi(
  client: AiClient,
  items: readonly AiItem[],
  categories: readonly Category[],
  opts: { model?: string; log?: (m: string) => void } = {},
): Promise<{ answers: Map<string, number | null>; inputTokens: number; outputTokens: number; skippedBatches: number }> {
  const model = opts.model ?? DEFAULT_AI_MODEL;
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  const schema = itemsSchema(categories);
  const system = systemPrompt(categories);
  const answers = new Map<string, number | null>();
  let inputTokens = 0;
  let outputTokens = 0;
  let skippedBatches = 0;

  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH);
    const list = batch
      .map((item, i) => `${i + 1}. ${item.description} (${item.direction === "saida" ? "saída" : "entrada"}, ${item.accountKind === "cartao" ? "cartão de crédito" : "conta corrente"})`)
      .join("\n");

    let response;
    try {
      response = await client.messages.parse({
        model,
        max_tokens: 8000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "low", format: zodOutputFormat(schema) },
        messages: [{ role: "user", content: `Classifique estes ${batch.length} lançamentos:\n${list}` }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AiError("A chave da Anthropic (ANTHROPIC_API_KEY) foi recusada. Confira o .env.");
      }
      if (error instanceof Anthropic.NotFoundError) {
        throw new AiError(`O modelo ${model} não está disponível para esta chave.`);
      }
      if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.InternalServerError) {
        // O SDK já tentou de novo; o resto fica para a próxima vez.
        opts.log?.(`IA: ${error instanceof Anthropic.RateLimitError ? "limite de uso atingido" : "sem contato com a API"}; o restante fica para depois.`);
        skippedBatches += Math.ceil((items.length - start) / BATCH);
        break;
      }
      throw error;
    }

    inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    outputTokens += response.usage.output_tokens;
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
      opts.log?.(`IA: um lote de ${batch.length} ficou sem resposta (${response.stop_reason}).`);
      skippedBatches++;
      continue;
    }
    for (const answer of response.parsed_output.itens) {
      const item = batch[answer.n - 1];
      if (!item || answers.has(item.key)) continue;
      answers.set(item.key, answer.categoria === NONE ? null : (byName.get(answer.categoria) ?? null));
    }
  }
  return { answers, inputTokens, outputTokens, skippedBatches };
}

/**
 * Sugere categorias com IA para os lançamentos ainda sem sugestão (não revisados, sem regra,
 * sem categoria do banco, sem estorno). Usa o que já está guardado e só pergunta o que é novo.
 */
export async function suggestWithAi(
  sql: Sql,
  client: AiClient,
  opts: { model?: string; log?: (m: string) => void } = {},
): Promise<AiRunResult> {
  const model = opts.model ?? DEFAULT_AI_MODEL;
  const rows = await sql<{ id: string; description: string; amount: string; kind: AccountKind }[]>`
    select t.id, t.description, t.amount, a.kind
    from transactions t join accounts a on a.id = t.account_id
    where not t.reviewed and t.category_id is null and t.duplicate_of is null and t.suspect_of is null
  `;
  const result: AiRunResult = { asked: 0, suggested: 0, unknown: 0, inputTokens: 0, outputTokens: 0, skippedBatches: 0 };
  if (rows.length === 0) return result;

  const byKey = new Map<string, { item: AiItem; ids: string[] }>();
  for (const r of rows) {
    const amount = Number(r.amount);
    const key = aiKey(r.description, amount, r.kind);
    const entry = byKey.get(key) ?? {
      item: { key, description: cleanDescription(r.description), direction: amount < 0 ? "saida" : "entrada", accountKind: r.kind },
      ids: [],
    };
    entry.ids.push(r.id);
    byKey.set(key, entry);
  }

  const cached = await sql<{ key: string; category_id: number | null }[]>`
    select key, category_id from ai_suggestions where key = any(${sql.array([...byKey.keys()])}::text[])
  `;
  const answers = new Map<string, number | null>(cached.map((c) => [c.key, c.category_id]));
  const toAsk = [...byKey.values()].filter((e) => !answers.has(e.item.key)).map((e) => e.item);

  if (toAsk.length > 0) {
    const categories = await listCategories(sql);
    const fresh = await classifyWithAi(client, toAsk, categories, { model, log: opts.log });
    result.asked = fresh.answers.size;
    result.inputTokens = fresh.inputTokens;
    result.outputTokens = fresh.outputTokens;
    result.skippedBatches = fresh.skippedBatches;
    for (const [key, categoryId] of fresh.answers) {
      answers.set(key, categoryId);
      await sql`
        insert into ai_suggestions (key, category_id, model) values (${key}, ${categoryId}, ${model})
        on conflict (key) do update set category_id = excluded.category_id, model = excluded.model, created_at = now()
      `;
    }
  }

  for (const [key, entry] of byKey) {
    const categoryId = answers.get(key);
    if (categoryId === undefined) continue;
    if (categoryId === null) {
      result.unknown++;
      continue;
    }
    // Só onde ainda não há sugestão (outra coisa pode ter classificado nesse meio-tempo).
    const updated = await sql`
      update transactions set category_id = ${categoryId}, category_source = 'ia', rule_id = null
      where id = any(${sql.array(entry.ids)}::bigint[]) and category_id is null and not reviewed
    `;
    result.suggested += updated.count;
  }
  return result;
}

/** Custo aproximado em dólares (Haiku 5.5: US$ 0,10 por milhão de tokens de entrada e US$ 0,50 de saída). */
export function estimateCostUsd(r: Pick<AiRunResult, "inputTokens" | "outputTokens">): number {
  return (r.inputTokens * 0.1 + r.outputTokens * 0.5) / 1_000_000;
}
