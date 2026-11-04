import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { ConfigError, CsvError, OfxError, loadConfig, type Config } from "@jatoba/core";
import { BackupError, createBackup, generateKey, listBackups, restoreBackup } from "./backup.js";
import { checkFile } from "./check.js";

const HELP = `Uso: jatoba <comando>

  backup               Cria um backup criptografado do banco em ${"$"}JATOBA_BACKUP_DIR
  list                 Lista os backups
  restore <arquivo>    Restaura um backup, com a chave privada num arquivo na pasta backups/:
                         docker compose exec app jatoba restore <arquivo> --chave chave-backup.txt --confirmar
                       (ou pela entrada padrão: ... --confirmar < chave-backup.txt)
  keygen               Gera o par de chaves dos backups
  check <arquivo>      Confere se um extrato OFX ou CSV é lido, mostrando só um resumo (sem descrições nem valores)

Rode dentro do contêiner, por exemplo: docker compose exec app jatoba backup`;

function config(): Config {
  return loadConfig();
}

function requireRecipient(cfg: Config): string {
  if (!cfg.JATOBA_BACKUP_RECIPIENT) {
    throw new BackupError(
      "JATOBA_BACKUP_RECIPIENT não está no .env, então não há como criptografar o backup.\n" +
        "Gere as chaves com: docker compose run --rm --no-deps app jatoba keygen",
    );
  }
  return cfg.JATOBA_BACKUP_RECIPIENT;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;

  switch (command) {
    case "backup": {
      const cfg = config();
      const file = await createBackup({
        databaseUrl: cfg.DATABASE_URL,
        recipient: requireRecipient(cfg),
        dir: cfg.JATOBA_BACKUP_DIR,
        reason: "manual",
      });
      console.log(`Backup criado: ${basename(file)}`);
      console.log("Na sua máquina ele fica na pasta backups/ do Jatobá. Guarde uma cópia fora deste computador.");
      return 0;
    }

    case "list": {
      const cfg = config();
      const backups = await listBackups(cfg.JATOBA_BACKUP_DIR);
      if (backups.length === 0) console.log("Nenhum backup ainda. Crie um com: docker compose exec app jatoba backup");
      for (const b of backups) console.log(`${b.name}  ${formatBytes(b.bytes)}`);
      return 0;
    }

    case "restore": {
      const cfg = config();
      // Argumentos: <arquivo> [--chave <arquivo-da-chave>] [--confirmar]
      const keyIndex = rest.indexOf("--chave");
      const keyName = keyIndex >= 0 ? rest[keyIndex + 1] : undefined;
      const name = rest.find((arg, i) => !arg.startsWith("--") && !(keyIndex >= 0 && i === keyIndex + 1));
      if (!name) {
        console.error("Informe o arquivo. Veja os disponíveis com: docker compose exec app jatoba list");
        return 2;
      }
      if (keyIndex >= 0 && !keyName) {
        console.error("Depois de --chave, informe o nome do arquivo da chave privada que está na pasta backups/.");
        return 2;
      }
      const file = isAbsolute(name) ? name : join(cfg.JATOBA_BACKUP_DIR, basename(name));
      if (!keyName && process.stdin.isTTY) {
        console.error(
          "Informe a chave privada sem que ela apareça na tela. O jeito mais simples, em qualquer sistema:\n" +
            "  1. salve a chave num arquivo, por exemplo chave-backup.txt, dentro da pasta backups/\n" +
            `  2. docker compose exec app jatoba restore ${basename(file)} --chave chave-backup.txt --confirmar\n` +
            "  3. apague o arquivo da chave em seguida",
        );
        return 2;
      }
      let identity: Readable = process.stdin;
      let keyPath: string | undefined;
      if (keyName) {
        keyPath = join(cfg.JATOBA_BACKUP_DIR, basename(keyName));
        let text: string;
        try {
          text = await readFile(keyPath, "utf8");
        } catch {
          console.error(`Não encontrei a chave em backups/${basename(keyName)}. Salve o arquivo da chave privada na pasta backups/ do Jatobá.`);
          return 1;
        }
        // Só as linhas da chave: tira fins de linha do Windows, espaços, BOM e comentários.
        const keys = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(l));
        if (keys.length === 0) {
          console.error(`O arquivo backups/${basename(keyName)} não contém uma chave privada do age (uma linha que começa com AGE-SECRET-KEY-1).`);
          return 1;
        }
        identity = Readable.from([`${keys.join("\n")}\n`]);
      }
      if (!rest.includes("--confirmar")) {
        console.error(
          `Isto substitui TODOS os dados atuais pelos de ${basename(file)}.\n` +
            "Antes, um backup de segurança do estado atual é criado automaticamente.\n" +
            "Para continuar, rode de novo com --confirmar no fim do comando.",
        );
        return 2;
      }
      const safety = await createBackup({
        databaseUrl: cfg.DATABASE_URL,
        recipient: requireRecipient(cfg),
        dir: cfg.JATOBA_BACKUP_DIR,
        reason: "antes-restauracao",
      });
      console.log(`Backup de segurança do estado atual: ${basename(safety)}`);
      await restoreBackup({ databaseUrl: cfg.DATABASE_URL, file, identity });
      console.log(`Restaurado: ${basename(file)}`);
      console.log("Agora reinicie a aplicação para ela conferir o banco: docker compose restart app");
      if (keyPath) console.log(`Importante: apague a chave privada da pasta backups/ (${basename(keyPath)}). Ela não deve ficar neste computador.`);
      return 0;
    }

    case "check": {
      const path = rest[0];
      if (!path) {
        console.error("Informe o arquivo: jatoba check <extrato.ofx ou .csv>");
        return 2;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        console.error(
          code === "ENOENT"
            ? `Arquivo não encontrado: ${path}\nConfira o caminho. No Windows, coloque-o entre aspas, por exemplo: "C:\\Users\\voce\\Financas\\extrato.ofx"`
            : `Não consegui ler ${path}: ${(error as Error).message}`,
        );
        return 1;
      }
      console.log(`Conferindo ${basename(path)}...`);
      console.log(checkFile(bytes).join("\n"));
      return 0;
    }

    case "keygen": {
      const { publicKey, secretKey } = await generateKey();
      console.log(`Chave PÚBLICA (vai no .env):
  JATOBA_BACKUP_RECIPIENT=${publicKey}

Chave PRIVADA (só ela abre os backups; guarde FORA deste computador,
num gerenciador de senhas ou impressa, e NUNCA no .env nem no Git):
  ${secretKey}

Sem a chave privada, nenhum backup pode ser restaurado. Se ela vazar,
gere um par novo e faça um backup novo.`);
      return 0;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return command === undefined ? 2 : 0;

    default:
      console.error(`Comando desconhecido: ${command}\n\n${HELP}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof BackupError || error instanceof ConfigError || error instanceof OfxError || error instanceof CsvError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
