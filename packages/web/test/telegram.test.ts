import { describe, expect, it } from "vitest";
import { computeProgress, detectSubscriptions, type MonthSummary } from "@jatoba/core";
import { HELP, createResponder, monthArg, type BotData } from "../src/bot-commands.js";
import { TelegramBot, parseCommand, tg, type Fetch } from "../src/telegram.js";

const TOKEN = "123456:SEGREDO-DO-TOKEN";

/** Telegram falso: registra o que o bot enviou e devolve respostas programadas. */
function fakeTelegram(responses: Record<string, unknown> = {}, fail?: string) {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, body });
    if (fail === method) return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
    return new Response(JSON.stringify({ ok: true, result: responses[method] ?? true }));
  };
  return { sent, fetch };
}

const msg = (id: number, chat: number, text: string) => ({ update_id: id, message: { chat: { id: chat }, text } });

describe("parseCommand e tg", () => {
  it("lê comando com @nome do bot e argumentos", () => {
    expect(parseCommand("/mes@JatobaBot 10/2026")).toEqual({ command: "/mes", args: ["10/2026"] });
    expect(parseCommand("  /METAS ")).toEqual({ command: "/metas", args: [] });
    expect(parseCommand("oi")).toBeUndefined();
  });

  it("escapa HTML do Telegram", () => {
    expect(tg("<script>&")).toBe("&lt;script&gt;&amp;");
  });
});

describe("TelegramBot", () => {
  it("responde só a chats autorizados e avisa no log o id de quem não está", async () => {
    const { sent, fetch } = fakeTelegram();
    const logs: string[] = [];
    const bot = new TelegramBot({ token: TOKEN, allowedChatIds: [111], respond: async (c) => `ok ${c}`, fetch, log: (m) => logs.push(m) });
    await bot.handle([msg(1, 111, "/mes"), msg(2, 999, "/mes"), msg(3, 999, "/metas")]);
    expect(sent).toEqual([{ method: "sendMessage", body: { chat_id: 111, text: "ok /mes", parse_mode: "HTML", disable_web_page_preview: true } }]);
    expect(logs.filter((l) => l.includes("id 999"))).toHaveLength(1);
  });

  it("texto que não é comando vira ajuda; mensagens de outros bots são ignoradas", async () => {
    const { sent, fetch } = fakeTelegram();
    const bot = new TelegramBot({ token: TOKEN, allowedChatIds: [111], respond: async (c) => c, fetch, log: () => {} });
    await bot.handle([msg(1, 111, "oi"), { update_id: 2, message: { chat: { id: 111 }, text: "/mes", from: { is_bot: true } } }]);
    expect(sent.map((s) => s.body.text)).toEqual(["/ajuda"]);
  });

  it("avança o offset para não receber a mesma mensagem de novo", async () => {
    const { sent, fetch } = fakeTelegram({ getUpdates: [msg(41, 111, "/mes"), msg(42, 111, "/metas")] });
    const bot = new TelegramBot({ token: TOKEN, allowedChatIds: [111], respond: async () => "x", fetch, log: () => {} });
    await bot.pollOnce();
    await bot.pollOnce();
    const polls = sent.filter((s) => s.method === "getUpdates").map((s) => s.body.offset);
    expect(polls).toEqual([0, 43]);
  });

  it("erro ao montar a resposta vira mensagem amigável; o token nunca aparece no log", async () => {
    const { sent, fetch } = fakeTelegram({}, "sendMessage");
    const logs: string[] = [];
    const bot = new TelegramBot({ token: TOKEN, allowedChatIds: [111], respond: async () => { throw new Error("banco fora"); }, fetch, log: (m) => logs.push(m) });
    await bot.handle([msg(1, 111, "/mes")]);
    expect(sent[0]!.body.text).toBe("Não consegui responder agora. Tente de novo em instantes.");
    expect(logs.join("\n")).toContain("401 Unauthorized");
    expect(logs.join("\n")).not.toContain("SEGREDO");
  });

  it("notify manda para todos os autorizados", async () => {
    const { sent, fetch } = fakeTelegram();
    const bot = new TelegramBot({ token: TOKEN, allowedChatIds: [111, 222], respond: async () => "", fetch, log: () => {} });
    await bot.notify("Importado.");
    expect(sent.map((s) => s.body.chat_id)).toEqual([111, 222]);
  });
});

const NOV: MonthSummary = {
  month: "2026-11-01", currency: "BRL", income: 801500, expenses: 55000, net: 746500,
  expenseCategories: [
    { categoryId: 1, name: "Mercado <&>", kind: "despesa", total: 40000, count: 1, outflow: 40000, inflow: 0 },
    { categoryId: 2, name: "Impostos e taxas", kind: "despesa", total: 0, count: 2, outflow: 9800, inflow: 9800 },
  ],
  incomeCategories: [], movements: [],
  uncategorized: { outflow: 3000, outflowCount: 1, inflow: 0, inflowCount: 0 },
  coverage: [{ accountId: 1, name: "Cartão C6", kind: "cartao", count: 0 }],
  previousMonths: [],
};

function data(over: Partial<BotData> = {}): BotData {
  const subs = detectSubscriptions(
    [
      { date: "2026-09-14", amount: 3990, description: "STREAMING", categoryName: null },
      { date: "2026-10-14", amount: 4490, description: "STREAMING", categoryName: null },
    ],
    "2026-11-04",
  );
  return {
    botName: "Jatobá",
    timeZone: "America/Sao_Paulo",
    months: async () => ["2026-11-01", "2026-10-01"],
    month: async () => NOV,
    goals: async () => [computeProgress({ id: 1, name: "Viagem", target: 1_000_000, deadline: "2027-12-01", archived: false }, 300_000, 180_000, "2026-11-04")],
    review: async () => ({ pending: 12, suspects: 1 }),
    subscriptions: async () => ({ active: subs, stopped: [], ignored: [], monthlyTotal: 4490 }),
    backup: async () => ({ configured: true, daily: true, hour: 3, keep: 14, count: 5, last: { name: "x", date: new Date("2026-11-04T06:00:00Z"), reason: "diario", bytes: 1 } }),
    ...over,
  };
}

describe("comandos do bot", () => {
  const nbsp = (s: string) => s.replace(/\s/g, " ");

  it("monthArg entende vários formatos", () => {
    const months = ["2026-11-01", "2026-10-01"];
    expect(monthArg(undefined, months)).toBe("2026-11-01");
    expect(monthArg("10/2026", months)).toBe("2026-10-01");
    expect(monthArg("2026-10", months)).toBe("2026-10-01");
    expect(monthArg("outubro", months)).toBe("2026-10-01");
    expect(monthArg("out", months)).toBe("2026-10-01");
    expect(monthArg("xyz", months)).toBeUndefined();
  });

  it("/mes: totais, maiores gastos (sem os zerados), sem categoria e mês incompleto, escapados", async () => {
    const text = nbsp(await createResponder(data({ publicUrl: "https://jatoba.exemplo.ts.net/" }))("/mes", []));
    expect(text).toContain("<b>Novembro de 2026</b>");
    expect(text).toContain("Saídas: R$ 550,00");
    expect(text).toContain("Saldo: <b>R$ 7.465,00</b>");
    expect(text).toContain("• Mercado &lt;&amp;&gt;: R$ 400,00");
    expect(text).not.toContain("Impostos e taxas");
    expect(text).toContain("1 lançamento(s) sem categoria");
    expect(text).toContain("Mês incompleto: falta Cartão C6.");
    expect(text).toContain('<a href="https://jatoba.exemplo.ts.net/mes?m=2026-11">Abrir o mês</a>');
  });

  it("/mes de um mês sem dados lista os disponíveis", async () => {
    expect(await createResponder(data())("/mes", ["01/2020"])).toContain("Meses disponíveis: novembro de 2026, outubro de 2026");
  });

  it("/metas, /revisar, /assinaturas e /backup", async () => {
    const r = createResponder(data());
    expect(nbsp(await r("/metas", []))).toContain("• <b>Viagem</b>: R$ 3.000,00 de R$ 10.000,00 (30%), no ritmo (R$ 500,00/mês)");
    expect(await r("/revisar", [])).toBe("12 lançamento(s) para revisar e 1 possível(is) duplicado(s).");
    const subs = nbsp(await r("/assinaturas", []));
    expect(subs).toContain("<b>Assinaturas</b>: 1, R$ 44,90 por mês");
    expect(subs).toContain("subiu de R$ 39,90");
    expect(await r("/backup", [])).toContain("Último backup: 04/11/2026, 03:00 (diario)");
  });

  it("sem dados, respostas claras; comando desconhecido mostra a ajuda", async () => {
    const r = createResponder(data({ months: async () => [], goals: async () => [], review: async () => ({ pending: 0, suspects: 0 }) }));
    expect(await r("/mes", [])).toContain("Ainda não há lançamentos");
    expect(await r("/metas", [])).toContain("Nenhuma meta ainda");
    expect(await r("/revisar", [])).toBe("Tudo revisado.");
    expect(await r("/xyz", [])).toContain(HELP("Jatobá"));
  });
});
