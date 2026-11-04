import { formatMoney, type GoalProgress, type MonthSummary, type SubscriptionList } from "@jatoba/core";
import type { BackupStatus } from "./scheduler.js";
import { tg } from "./telegram.js";

/** Respostas dos comandos do bot. Separadas do bot para testar sem Telegram. */

export interface BotData {
  months: () => Promise<string[]>;
  month: (month: string) => Promise<MonthSummary>;
  goals: () => Promise<GoalProgress[]>;
  review: () => Promise<{ pending: number; suspects: number }>;
  subscriptions: () => Promise<SubscriptionList>;
  backup: () => Promise<BackupStatus>;
  botName: string;
  /** Fuso do .env (TZ), para mostrar horários. */
  timeZone: string;
  /** Endereço da página (Tailscale), para links; opcional. */
  publicUrl?: string;
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const title = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} de ${iso.slice(0, 4)}`;
const brl = (cents: number) => tg(formatMoney(cents, "pt-BR", "BRL"));
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** "10/2026", "2026-10", "out" ou "outubro" (do ano dos dados) → "2026-10-01". */
export function monthArg(arg: string | undefined, months: string[]): string | undefined {
  if (!arg) return months[0];
  const a = arg.toLowerCase();
  let m = a.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1]!.padStart(2, "0")}-01`;
  m = a.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-01`;
  const index = MONTHS.findIndex((name) => name.startsWith(a.slice(0, 3)) && a.length >= 3);
  if (index >= 0) return months.find((x) => Number(x.slice(5, 7)) === index + 1);
  return undefined;
}

export const HELP = (name: string) => `<b>${tg(name)}</b>: o que posso mostrar

/mes: resumo do mês mais recente (ou /mes 10/2026)
/metas: progresso das metas
/revisar: o que falta revisar
/assinaturas: assinaturas ativas e reajustes
/backup: situação dos backups

Só consulto; nada é alterado por aqui.`;

export function createResponder(data: BotData): (command: string, args: string[]) => Promise<string> {
  const link = (path: string, label: string) => (data.publicUrl ? `\n<a href="${tg(data.publicUrl.replace(/\/$/, "") + path)}">${tg(label)}</a>` : "");

  return async (command, args) => {
    switch (command) {
      case "/start":
      case "/ajuda":
      case "/help":
        return HELP(data.botName);

      case "/mes": {
        const months = await data.months();
        if (months.length === 0) return "Ainda não há lançamentos. Importe um extrato na página do Jatobá.";
        const month = monthArg(args[0], months);
        if (!month || !months.includes(month)) return `Não há dados para ${tg(args[0] ?? "esse mês")}. Meses disponíveis: ${months.slice(0, 6).map((m) => title(m)).join(", ")}.`;
        const s = await data.month(month);
        const top = s.expenseCategories.filter((c) => c.total > 0).slice(0, 5);
        const lines = [
          `<b>${tg(title(month).replace(/^./, (c) => c.toUpperCase()))}</b>`,
          `Entradas: ${brl(s.income)}`,
          `Saídas: ${brl(s.expenses)}`,
          `Saldo: <b>${brl(s.net)}</b>`,
        ];
        if (top.length) lines.push("", "<b>Maiores gastos</b>", ...top.map((c) => `• ${tg(c.name)}: ${brl(c.total)}`));
        const uncategorized = s.uncategorized.outflowCount + s.uncategorized.inflowCount;
        if (uncategorized) lines.push("", `${uncategorized} lançamento(s) sem categoria (contados nos totais).`);
        const missing = s.coverage.filter((c) => c.count === 0);
        if (missing.length) lines.push(`Mês incompleto: falta ${missing.map((c) => tg(c.name)).join(", ")}.`);
        return lines.join("\n") + link(`/mes?m=${month.slice(0, 7)}`, "Abrir o mês");
      }

      case "/metas": {
        const goals = await data.goals();
        if (goals.length === 0) return "Nenhuma meta ainda. Crie na página Metas do Jatobá.";
        const lines = goals.map((g) => {
          const status =
            g.status === "atingida" ? "meta atingida" :
            g.status === "no-ritmo" ? `no ritmo (${brl(g.monthlyNeeded!)}/mês)` :
            g.status === "abaixo" ? `abaixo do ritmo: guardar ${brl(g.monthlyNeeded!)}/mês` :
            g.status === "prazo-vencido" ? "prazo vencido" :
            g.status === "sem-prazo" ? `chega em ${g.monthsAtPace} mês(es) no ritmo atual` : "sem prazo";
          return `• <b>${tg(g.name)}</b>: ${brl(g.saved)} de ${brl(g.target)} (${g.percent}%), ${status}`;
        });
        return ["<b>Metas</b>", ...lines].join("\n") + link("/metas", "Abrir metas");
      }

      case "/revisar": {
        const { pending, suspects } = await data.review();
        if (pending === 0 && suspects === 0) return "Tudo revisado.";
        const parts = [];
        if (pending) parts.push(`${pending} lançamento(s) para revisar`);
        if (suspects) parts.push(`${suspects} possível(is) duplicado(s)`);
        return `${parts.join(" e ")}.` + link("/revisar", "Abrir Revisar");
      }

      case "/assinaturas": {
        const list = await data.subscriptions();
        if (list.active.length === 0) return "Nenhuma assinatura ativa encontrada.";
        const lines = list.active.slice(0, 15).map((s) => {
          const change = s.previousAmount !== undefined ? ` (${s.lastAmount > s.previousAmount ? "subiu" : "baixou"} de ${brl(s.previousAmount)})` : "";
          const late = s.late ? ", prevista e ainda não apareceu" : "";
          return `• ${tg(s.name)}: ${brl(s.lastAmount)}${change}, próxima ~${br(s.nextDate)}${late}`;
        });
        return [`<b>Assinaturas</b>: ${list.active.length}, ${brl(list.monthlyTotal)} por mês`, ...lines].join("\n") + link("/assinaturas", "Abrir assinaturas");
      }

      case "/backup": {
        const b = await data.backup();
        if (!b.configured) return "Backup não configurado. Veja Ajustes → Backups na página do Jatobá.";
        if (!b.last) return "Nenhum backup ainda.";
        const days = Math.floor((Date.now() - b.last.date.getTime()) / (24 * 60 * 60_000));
        return [
          `Último backup: ${tg(b.last.date.toLocaleString("pt-BR", { timeZone: data.timeZone, dateStyle: "short", timeStyle: "short" }))} (${tg(b.last.reason)})${days >= 7 ? `, <b>há ${days} dias</b>` : ""}`,
          `${b.count} arquivo(s). ${b.daily ? `Automático todo dia a partir das ${b.hour}h.` : "Automático desligado."}`,
          "Lembre de copiar alguns para fora do computador.",
        ].join("\n");
      }

      default:
        return `Não conheço esse comando.\n\n${HELP(data.botName)}`;
    }
  };
}
