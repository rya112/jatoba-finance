import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createBackup, listBackups } from "./backup.js";

/**
 * Backup automático diário: roda uma vez por dia, a partir da hora configurada (no fuso do .env).
 * Se o computador estava desligado nessa hora, roda assim que voltar. Guarda os últimos N diários;
 * nunca apaga backups manuais nem os feitos antes de migrações e restaurações.
 */

export const DAILY_REASON = "diario";
const NAME = /^jatoba-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z0-9-]+)\.sql\.age$/;

/** Data (UTC) e motivo gravados no nome do arquivo. */
export function parseBackupName(name: string): { date: Date; reason: string } | undefined {
  const m = name.match(NAME);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, reason] = m;
  return { date: new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!)), reason: reason! };
}

/** Data e hora locais (AAAA-MM-DD e 0-23) no fuso dado. */
export function localParts(date: Date, timeZone: string): { day: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Já passou da hora de hoje e ainda não há backup diário de hoje? */
export function dailyBackupDue(now: Date, lastDaily: Date | undefined, hour: number, timeZone: string): boolean {
  const today = localParts(now, timeZone);
  if (today.hour < hour) return false;
  return !lastDaily || localParts(lastDaily, timeZone).day < today.day;
}

export interface BackupStatus {
  configured: boolean;
  daily: boolean;
  hour: number;
  keep: number;
  count: number;
  last?: { name: string; date: Date; reason: string; bytes: number };
  lastDaily?: Date;
}

export async function backupStatus(opts: { dir: string; configured: boolean; daily: boolean; hour: number; keep: number }): Promise<BackupStatus> {
  const files = (await listBackups(opts.dir))
    .map((f) => ({ ...f, parsed: parseBackupName(f.name) }))
    .filter((f): f is typeof f & { parsed: { date: Date; reason: string } } => f.parsed !== undefined)
    .sort((a, b) => a.parsed.date.getTime() - b.parsed.date.getTime());
  const last = files.at(-1);
  const lastDaily = files.filter((f) => f.parsed.reason === DAILY_REASON).at(-1);
  return {
    configured: opts.configured,
    daily: opts.daily,
    hour: opts.hour,
    keep: opts.keep,
    count: files.length,
    last: last ? { name: last.name, date: last.parsed.date, reason: last.parsed.reason, bytes: last.bytes } : undefined,
    lastDaily: lastDaily?.parsed.date,
  };
}

/** Apaga os diários mais antigos, mantendo os `keep` mais recentes. Devolve os nomes apagados. */
export async function pruneDailyBackups(dir: string, keep: number): Promise<string[]> {
  const daily = (await listBackups(dir))
    .map((f) => ({ name: f.name, parsed: parseBackupName(f.name) }))
    .filter((f) => f.parsed?.reason === DAILY_REASON)
    .sort((a, b) => b.parsed!.date.getTime() - a.parsed!.date.getTime());
  const old = daily.slice(keep).map((f) => f.name);
  for (const name of old) await rm(join(dir, name), { force: true });
  return old;
}

export interface SchedulerOptions {
  databaseUrl: string;
  recipient?: string;
  dir: string;
  daily: boolean;
  hour: number;
  keep: number;
  timeZone: string;
  log?: (message: string) => void;
  /** Para testes: relógio e intervalo. */
  now?: () => Date;
  intervalMs?: number;
}

/** Uma checagem: faz o backup diário se estiver na hora. Devolve o arquivo criado, se houver. */
export async function runDailyBackupIfDue(opts: SchedulerOptions): Promise<string | undefined> {
  if (!opts.daily || !opts.recipient) return undefined;
  const status = await backupStatus({ dir: opts.dir, configured: true, daily: true, hour: opts.hour, keep: opts.keep });
  const now = (opts.now ?? (() => new Date()))();
  if (!dailyBackupDue(now, status.lastDaily, opts.hour, opts.timeZone)) return undefined;
  const file = await createBackup({ databaseUrl: opts.databaseUrl, recipient: opts.recipient, dir: opts.dir, reason: DAILY_REASON, now });
  const removed = await pruneDailyBackups(opts.dir, opts.keep);
  opts.log?.(`Backup diário criado: ${file.split(/[\\/]/).pop()}${removed.length ? ` (${removed.length} diário(s) antigo(s) apagado(s))` : ""}`);
  return file;
}

/** Checa a cada 10 minutos (e 1 minuto depois de subir). Depois de uma falha, espera 1 hora. */
export function startScheduler(opts: SchedulerOptions): { stop: () => void } {
  const log = opts.log ?? console.log;
  let running = false;
  let pausedUntil = 0;
  const tick = async () => {
    if (running || Date.now() < pausedUntil) return;
    running = true;
    try {
      await runDailyBackupIfDue({ ...opts, log });
    } catch (error) {
      pausedUntil = Date.now() + 60 * 60_000;
      log(`Backup diário falhou; nova tentativa em 1 hora: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, opts.intervalMs ?? 10 * 60_000);
  first.unref();
  timer.unref();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
