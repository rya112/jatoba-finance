import { basename, isAbsolute, join } from "node:path";
import { ConfigError, loadConfig, type Config } from "@jatoba/core";
import { BackupError, createBackup, generateKey, listBackups, restoreBackup } from "./backup.js";

const HELP = `Uso: jatoba <comando>

  backup               Cria um backup criptografado do banco em ${"$"}JATOBA_BACKUP_DIR
  list                 Lista os backups
  restore <arquivo>    Restaura um backup. A chave privada entra pela entrada padrão:
                         docker compose exec -T app jatoba restore <arquivo> --confirmar < chave-backup.txt
  keygen               Gera o par de chaves dos backups

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
      const name = rest.find((arg) => !arg.startsWith("--"));
      if (!name) {
        console.error("Informe o arquivo. Veja os disponíveis com: docker compose exec app jatoba list");
        return 2;
      }
      const file = isAbsolute(name) ? name : join(cfg.JATOBA_BACKUP_DIR, basename(name));
      if (process.stdin.isTTY) {
        console.error(
          "A chave privada precisa entrar pela entrada padrão, sem aparecer na tela:\n" +
            `  docker compose exec -T app jatoba restore ${basename(file)} --confirmar < chave-backup.txt`,
        );
        return 2;
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
      await restoreBackup({ databaseUrl: cfg.DATABASE_URL, file, identity: process.stdin });
      console.log(`Restaurado: ${basename(file)}`);
      console.log("Agora reinicie a aplicação para ela conferir o banco: docker compose restart app");
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
  if (error instanceof BackupError || error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
