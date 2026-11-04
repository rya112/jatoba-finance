import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupStatus, dailyBackupDue, localParts, parseBackupName, pruneDailyBackups, runDailyBackupIfDue } from "../src/scheduler.js";

const SP = "America/Sao_Paulo";

describe("parseBackupName", () => {
  it("lê data (UTC) e motivo do nome", () => {
    expect(parseBackupName("jatoba-20261104-063000-diario.sql.age")).toEqual({ date: new Date("2026-11-04T06:30:00Z"), reason: "diario" });
    expect(parseBackupName("jatoba-20261104-063000-antes-migracao.sql.age")!.reason).toBe("antes-migracao");
    expect(parseBackupName("outro.txt")).toBeUndefined();
  });
});

describe("localParts e dailyBackupDue (fuso de São Paulo, UTC−3)", () => {
  it("converte para o dia e a hora locais", () => {
    expect(localParts(new Date("2026-11-04T02:30:00Z"), SP)).toEqual({ day: "2026-11-03", hour: 23 });
    expect(localParts(new Date("2026-11-04T06:00:00Z"), SP)).toEqual({ day: "2026-11-04", hour: 3 });
  });

  it("antes da hora: não; depois da hora sem backup de hoje: sim", () => {
    expect(dailyBackupDue(new Date("2026-11-04T05:59:00Z"), undefined, 3, SP)).toBe(false); // 02:59 local
    expect(dailyBackupDue(new Date("2026-11-04T06:00:00Z"), undefined, 3, SP)).toBe(true); // 03:00 local
  });

  it("já fez hoje: não; o de ontem não conta", () => {
    const now = new Date("2026-11-04T15:00:00Z"); // 12:00 local
    expect(dailyBackupDue(now, new Date("2026-11-04T06:05:00Z"), 3, SP)).toBe(false);
    expect(dailyBackupDue(now, new Date("2026-11-03T06:05:00Z"), 3, SP)).toBe(true);
  });

  it("computador desligado na hora: faz assim que ligar", () => {
    expect(dailyBackupDue(new Date("2026-11-04T21:00:00Z"), new Date("2026-11-02T06:00:00Z"), 3, SP)).toBe(true); // 18:00 local
  });

  it("o dia é o local: 23h de ontem em São Paulo (02h UTC de hoje) não conta como hoje", () => {
    const lastNight = new Date("2026-11-04T02:00:00Z"); // 23:00 de 03/11 local
    expect(dailyBackupDue(new Date("2026-11-04T07:00:00Z"), lastNight, 3, SP)).toBe(true);
  });
});

describe("retenção e situação dos backups", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jatoba-sched-"));
    const names = [
      "jatoba-20261101-060000-diario.sql.age",
      "jatoba-20261102-060000-diario.sql.age",
      "jatoba-20261103-060000-diario.sql.age",
      "jatoba-20261104-060000-diario.sql.age",
      "jatoba-20261020-120000-manual.sql.age",
      "jatoba-20261021-120000-antes-migracao.sql.age",
      "anotacoes.txt",
    ];
    for (const n of names) await writeFile(join(dir, n), "x".repeat(10));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mantém os N diários mais recentes e nunca apaga manuais nem os de antes de migração", async () => {
    const removed = await pruneDailyBackups(dir, 2);
    expect(removed).toEqual(["jatoba-20261102-060000-diario.sql.age", "jatoba-20261101-060000-diario.sql.age"]);
    expect((await readdir(dir)).sort()).toEqual([
      "anotacoes.txt",
      "jatoba-20261020-120000-manual.sql.age",
      "jatoba-20261021-120000-antes-migracao.sql.age",
      "jatoba-20261103-060000-diario.sql.age",
      "jatoba-20261104-060000-diario.sql.age",
    ]);
  });

  it("situação: quantos, o último e o último diário", async () => {
    const s = await backupStatus({ dir, configured: true, daily: true, hour: 3, keep: 14 });
    expect(s).toMatchObject({ count: 6, last: { name: "jatoba-20261104-060000-diario.sql.age", reason: "diario", bytes: 10 } });
    expect(s.lastDaily).toEqual(new Date("2026-11-04T06:00:00Z"));
  });

  it("não roda sem chave, desligado, ou se já fez hoje (sem chamar o pg_dump)", async () => {
    const base = { databaseUrl: "postgres://x:y@nada/z", dir, hour: 3, keep: 14, timeZone: SP, now: () => new Date("2026-11-04T15:00:00Z") };
    expect(await runDailyBackupIfDue({ ...base, daily: true })).toBeUndefined();
    expect(await runDailyBackupIfDue({ ...base, daily: false, recipient: "age1x" })).toBeUndefined();
    expect(await runDailyBackupIfDue({ ...base, daily: true, recipient: "age1x" })).toBeUndefined(); // já há o de 04/11
  });
});
