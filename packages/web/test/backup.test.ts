import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@jatoba/core";
import { backupFileName, listBackups, pgEnv } from "../src/backup.js";

describe("pgEnv", () => {
  it("separa o endereço do banco em variáveis, decodificando a senha", () => {
    const env = pgEnv("postgres://jatoba:s%40nha@postgres:5432/jatoba");
    expect(env).toMatchObject({ PGHOST: "postgres", PGPORT: "5432", PGUSER: "jatoba", PGPASSWORD: "s@nha", PGDATABASE: "jatoba" });
  });

  it("usa a porta padrão quando o endereço não tem porta", () => {
    expect(pgEnv("postgres://u:p@db/x").PGPORT).toBe("5432");
  });
});

describe("backupFileName", () => {
  it("usa data e hora em UTC e o motivo", () => {
    expect(backupFileName(new Date("2026-11-03T09:15:30.123Z"), "antes-migracao")).toBe("jatoba-20261103-091530-antes-migracao.sql.age");
  });

  it("limpa motivos com caracteres estranhos", () => {
    expect(backupFileName(new Date("2026-01-02T03:04:05Z"), "Antes da Restauração!")).toBe("jatoba-20260102-030405-antes-da-restaura-o.sql.age");
    expect(backupFileName(new Date("2026-01-02T03:04:05Z"), "")).toBe("jatoba-20260102-030405-manual.sql.age");
  });
});

describe("listBackups", () => {
  it("lista só backups do Jatobá, em ordem, e ignora arquivos pela metade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jatoba-backups-"));
    try {
      await writeFile(join(dir, "jatoba-20261103-091530-manual.sql.age"), "x".repeat(10));
      await writeFile(join(dir, "jatoba-20261101-000000-antes-migracao.sql.age"), "y");
      await writeFile(join(dir, "jatoba-20261104-000000-manual.sql.age.part"), "z");
      await writeFile(join(dir, "outro.txt"), "w");
      expect(await listBackups(dir)).toEqual([
        { name: "jatoba-20261101-000000-antes-migracao.sql.age", bytes: 1 },
        { name: "jatoba-20261103-091530-manual.sql.age", bytes: 10 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("devolve lista vazia se a pasta não existe", async () => {
    expect(await listBackups(join(tmpdir(), "nao-existe-jatoba"))).toEqual([]);
  });
});

describe("JATOBA_BACKUP_RECIPIENT", () => {
  const base = {
    JATOBA_ADMIN_USER: "ricardo",
    JATOBA_ADMIN_PASSWORD: "uma-frase-bem-longa-de-teste",
    DATABASE_URL: "postgres://jatoba:abc123@postgres:5432/jatoba",
  };

  it("aceita uma chave pública do age", () => {
    const key = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    expect(loadConfig({ ...base, JATOBA_BACKUP_RECIPIENT: key }).JATOBA_BACKUP_RECIPIENT).toBe(key);
  });

  it("recusa a chave privada colada por engano", () => {
    expect(() =>
      loadConfig({ ...base, JATOBA_BACKUP_RECIPIENT: "AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGP" }),
    ).toThrow(/chave pública do age/);
  });

  it("é opcional", () => {
    expect(loadConfig(base).JATOBA_BACKUP_RECIPIENT).toBeUndefined();
    expect(loadConfig(base).JATOBA_BACKUP_DIR).toBe("/backups");
  });
});
