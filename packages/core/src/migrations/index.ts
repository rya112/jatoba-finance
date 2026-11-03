/**
 * Migrações do banco, em ordem. Regras:
 * - Nunca altere uma migração que já foi publicada; crie uma nova.
 * - O id começa com 4 dígitos sequenciais e diz o que a migração faz.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_sessions",
    sql: `
      create table sessions (
        token_hash  bytea primary key,
        created_at  timestamptz not null default now(),
        expires_at  timestamptz not null
      );
      create index sessions_expires_at_idx on sessions (expires_at);
    `,
  },
];
