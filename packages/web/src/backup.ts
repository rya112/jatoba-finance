import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/** Variáveis libpq para pg_dump e psql, sem pôr a senha na linha de comando. */
export function pgEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  return {
    PATH: process.env.PATH,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

/** jatoba-20261103-091500-manual.sql.age, em UTC, que ordena por data. */
export function backupFileName(date: Date, reason: string): string {
  const stamp = date.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  const slug = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "manual";
  return `jatoba-${stamp}-${slug}.sql.age`;
}

const BACKUP_PATTERN = /^jatoba-\d{8}-\d{6}-[a-z0-9-]+\.sql\.age$/;

export async function listBackups(dir: string): Promise<{ name: string; bytes: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const backups = [];
  for (const name of names.filter((n) => BACKUP_PATTERN.test(n)).sort()) {
    backups.push({ name, bytes: (await stat(join(dir, name))).size });
  }
  return backups;
}

/** Espera o processo terminar e devolve o código de saída e o que ele escreveu no stderr. */
function finished(child: ChildProcess, name: string): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.on("error", (error) => reject(new BackupError(`não consegui rodar ${name}: ${error.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr: stderr.trim() }));
  });
}

async function ensureWritable(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch {
    throw new BackupError(
      `A pasta de backups (${dir}) não aceita gravação. ` +
        "No Linux, rode na pasta do Jatobá: mkdir -p backups && sudo chown 1000:1000 backups",
    );
  }
}

/**
 * pg_dump | age -r <chave pública> > arquivo.
 * Grava num .part e só renomeia no fim, para nunca deixar um backup pela metade com nome de pronto.
 */
export async function createBackup(opts: { databaseUrl: string; recipient: string; dir: string; reason: string; now?: Date }): Promise<string> {
  await ensureWritable(opts.dir);
  const file = join(opts.dir, backupFileName(opts.now ?? new Date(), opts.reason));
  const partial = `${file}.part`;

  const dump = spawn("pg_dump", ["--no-owner", "--no-privileges", "--format=plain"], {
    env: pgEnv(opts.databaseUrl),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const encrypt = spawn("age", ["--encrypt", "--recipient", opts.recipient, "--output", partial], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  dump.stdout!.pipe(encrypt.stdin!);

  const [dumpResult, encryptResult] = await Promise.all([finished(dump, "pg_dump"), finished(encrypt, "age")]);
  if (dumpResult.code !== 0 || encryptResult.code !== 0) {
    await rm(partial, { force: true });
    const detail = dumpResult.code !== 0 ? `pg_dump: ${dumpResult.stderr}` : `age: ${encryptResult.stderr}`;
    throw new BackupError(`O backup falhou e nenhum arquivo foi criado. ${detail}`);
  }
  await rename(partial, file);
  return file;
}

/**
 * age -d -i <chave privada> arquivo | psql, numa única transação:
 * apaga o esquema atual e carrega o do backup. Se qualquer coisa falhar, o banco fica como estava.
 */
export async function restoreBackup(opts: { databaseUrl: string; file: string; identity: Readable }): Promise<void> {
  try {
    await access(opts.file, constants.R_OK);
  } catch {
    throw new BackupError(`Arquivo de backup não encontrado: ${opts.file}`);
  }

  const decrypt = spawn("age", ["--decrypt", "--identity", "-", opts.file], { stdio: ["pipe", "pipe", "pipe"] });
  opts.identity.pipe(decrypt.stdin!);

  const load = spawn("psql", ["--quiet", "--no-psqlrc", "--single-transaction", "--set", "ON_ERROR_STOP=1", "--output", "/dev/null"], {
    env: pgEnv(opts.databaseUrl),
    stdio: ["pipe", "ignore", "pipe"],
  });
  load.stdin!.write("drop schema public cascade;\ncreate schema public;\n");
  // O psql confirma a transação quando a entrada termina. Por isso a entrada só é fechada
  // se o age terminou bem; se ele falhou (chave errada, arquivo corrompido no meio), o psql
  // é morto antes de confirmar e o Postgres desfaz tudo.
  decrypt.stdout!.pipe(load.stdin!, { end: false });
  const loadDone = finished(load, "psql");
  const decryptResult = await finished(decrypt, "age");
  if (decryptResult.code === 0) load.stdin!.end();
  else load.kill("SIGKILL");
  const loadResult = await loadDone;

  if (decryptResult.code !== 0) {
    throw new BackupError(
      `Não consegui abrir o backup; o banco não foi alterado. Confira se a chave privada é a certa. (age: ${decryptResult.stderr})`,
    );
  }
  if (loadResult.code !== 0) {
    throw new BackupError(`A restauração falhou; o banco não foi alterado. (psql: ${loadResult.stderr})`);
  }
}

/** Gera um par de chaves do age. A privada fica só com quem rodou o comando. */
export async function generateKey(): Promise<{ publicKey: string; secretKey: string }> {
  const keygen = spawn("age-keygen", [], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  keygen.stdout!.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const result = await finished(keygen, "age-keygen");
  const publicKey = out.match(/public key: (age1[0-9a-z]+)/)?.[1];
  const secretKey = out.match(/^AGE-SECRET-KEY-[0-9A-Z]+$/m)?.[0];
  if (result.code !== 0 || !publicKey || !secretKey) throw new BackupError(`age-keygen falhou: ${result.stderr}`);
  return { publicKey, secretKey };
}
