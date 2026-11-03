import type { Sql } from "./db.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

/** Número fixo do lock, para duas instâncias nunca migrarem ao mesmo tempo. */
const MIGRATION_LOCK = 7_215_001;

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

function checkOrder(migrations: readonly Migration[]): void {
  for (let i = 0; i < migrations.length; i++) {
    const id = migrations[i]!.id;
    if (!/^\d{4}_[a-z0-9_]+$/.test(id)) throw new MigrationError(`id de migração inválido: ${id}`);
    if (i > 0 && migrations[i - 1]!.id >= id) throw new MigrationError(`migrações fora de ordem: ${migrations[i - 1]!.id} e ${id}`);
  }
}

/**
 * Migrações ainda não aplicadas e se o banco já tinha alguma.
 * Num banco recém-criado, `hasData` é false e não há o que proteger com backup.
 */
export async function pendingMigrations(sql: Sql, migrations: readonly Migration[] = MIGRATIONS): Promise<{ pending: string[]; hasData: boolean }> {
  const [table] = await sql<{ name: string | null }[]>`select to_regclass('public.schema_migrations')::text as name`;
  if (!table?.name) return { pending: migrations.map((m) => m.id), hasData: false };
  const rows = await sql<{ id: string }[]>`select id from schema_migrations`;
  const applied = new Set(rows.map((row) => row.id));
  return { pending: migrations.filter((m) => !applied.has(m.id)).map((m) => m.id), hasData: true };
}

/**
 * Aplica as migrações pendentes numa única transação.
 * Se qualquer uma falhar, nada é aplicado e o banco fica como estava.
 * Devolve os ids aplicados agora.
 */
export async function migrate(sql: Sql, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  checkOrder(migrations);
  const known = new Set(migrations.map((m) => m.id));

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`
      create table if not exists schema_migrations (
        id          text primary key,
        applied_at  timestamptz not null default now()
      )
    `;
    const rows = await tx<{ id: string }[]>`select id from schema_migrations`;
    const applied = new Set(rows.map((row) => row.id));

    const unknown = [...applied].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new MigrationError(
        `O banco tem migrações que esta versão não conhece (${unknown.join(", ")}). ` +
          "Ele foi usado por uma versão mais nova do Jatobá; volte para ela ou restaure um backup.",
      );
    }

    const done: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      try {
        if (migration.sql) await tx.unsafe(migration.sql);
        if (migration.run) await migration.run(tx);
      } catch (error) {
        throw new MigrationError(`A migração ${migration.id} falhou; nada foi alterado no banco.`, { cause: error });
      }
      await tx`insert into schema_migrations (id) values (${migration.id})`;
      done.push(migration.id);
    }
    return done;
  });
}
