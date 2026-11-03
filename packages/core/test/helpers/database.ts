import postgres from "postgres";

/** Endereço de um Postgres de teste. Sem ele, os testes de banco são pulados. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Cria um banco vazio só para um arquivo de teste e devolve como apagá-lo depois. */
export async function freshDatabase(name: string): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL não definida");
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  const database = `jatoba_test_${name}_${process.pid}`;
  await admin.unsafe(`drop database if exists ${database} with (force)`);
  await admin.unsafe(`create database ${database}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    },
  };
}
