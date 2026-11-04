/**
 * Bot do Telegram, opcional. Busca mensagens por long polling (não precisa abrir porta nem expor o
 * Jatobá na internet) e só responde aos chat IDs de TELEGRAM_ALLOWED_CHAT_IDS. Só lê: não recebe
 * extratos nem muda nada. O token nunca aparece em logs.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface BotOptions {
  token: string;
  allowedChatIds: readonly number[];
  /** Responde a um comando ("/mes", ["2026-10"]). Devolve o texto (HTML simples do Telegram). */
  respond: (command: string, args: string[]) => Promise<string>;
  fetch?: Fetch;
  log?: (message: string) => void;
  /** Espera entre tentativas depois de um erro de rede. */
  retryMs?: number;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { is_bot?: boolean } };
}

/** Escapa o texto para o modo HTML do Telegram. */
export function tg(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "/mes@JatobaBot 2026-10" → { command: "/mes", args: ["2026-10"] }. */
export function parseCommand(text: string): { command: string; args: string[] } | undefined {
  const [first, ...args] = text.trim().split(/\s+/);
  if (!first?.startsWith("/")) return undefined;
  return { command: first.split("@")[0]!.toLowerCase(), args };
}

export class TelegramBot {
  private offset = 0;
  private running = false;
  private readonly fetch: Fetch;
  private readonly log: (message: string) => void;
  private readonly unknownChats = new Set<number>();
  private controller?: AbortController;

  constructor(private readonly opts: BotOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.log = opts.log ?? console.log;
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const signal = this.controller ? AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await this.fetch(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
    // A mensagem de erro do Telegram nunca contém o token; a URL, sim — por isso ela não é registrada.
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.error_code ?? res.status} ${json.description ?? ""}`.trim());
    return json.result;
  }

  async send(chatId: number, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
  }

  /** Aviso para todos os chats autorizados. Falhas não derrubam quem chamou. */
  async notify(text: string): Promise<void> {
    for (const chatId of this.opts.allowedChatIds) {
      try {
        await this.send(chatId, text);
      } catch (error) {
        this.log(`Bot: não consegui enviar aviso: ${(error as Error).message}`);
      }
    }
  }

  /** Trata as atualizações recebidas. Separado do laço para poder testar. */
  async handle(updates: Update[]): Promise<void> {
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const msg = update.message;
      if (!msg?.text || msg.from?.is_bot) continue;
      const chatId = msg.chat.id;
      if (!this.opts.allowedChatIds.includes(chatId)) {
        if (!this.unknownChats.has(chatId)) {
          this.unknownChats.add(chatId);
          this.log(`Bot: mensagem de um chat não autorizado (id ${chatId}). Se for você, ponha esse id em TELEGRAM_ALLOWED_CHAT_IDS no .env.`);
        }
        continue; // não responde a quem não está autorizado
      }
      const parsed = parseCommand(msg.text);
      let reply: string;
      try {
        reply = await this.opts.respond(parsed?.command ?? "/ajuda", parsed?.args ?? []);
      } catch (error) {
        this.log(`Bot: erro ao responder ${parsed?.command ?? "mensagem"}: ${(error as Error).message}`);
        reply = "Não consegui responder agora. Tente de novo em instantes.";
      }
      try {
        await this.send(chatId, reply);
      } catch (error) {
        this.log(`Bot: não consegui responder: ${(error as Error).message}`);
      }
    }
  }

  /** Uma rodada de long polling (até 50 s esperando mensagem). */
  async pollOnce(): Promise<void> {
    const updates = await this.call<Update[]>("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
    await this.handle(updates);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const loop = async () => {
      while (this.running) {
        try {
          await this.pollOnce();
        } catch (error) {
          if (!this.running) break;
          this.log(`Bot: sem contato com o Telegram (${(error as Error).message}); nova tentativa em instantes.`);
          await new Promise((resolve) => setTimeout(resolve, this.opts.retryMs ?? 30_000).unref?.());
        }
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
  }
}
