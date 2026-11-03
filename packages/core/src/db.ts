import postgres from "postgres";

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, {
    max: 5,
    onnotice: () => {},
    connection: { application_name: "jatoba" },
  });
}

/** Espera o Postgres aceitar conexões. Útil na partida, quando o banco ainda está subindo. */
export async function waitForDatabase(sql: Sql, { attempts = 30, delayMs = 1000 } = {}): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** true se o banco responde. Usado pela verificação de saúde. */
export async function isDatabaseUp(sql: Sql): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
