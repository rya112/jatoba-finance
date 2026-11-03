import type postgres from "postgres";
import { contentFingerprint } from "./0003_content_fingerprint.js";

/**
 * Migrações do banco, em ordem. Regras:
 * - Nunca altere uma migração que já foi publicada; crie uma nova.
 * - O id começa com 4 dígitos sequenciais e diz o que a migração faz.
 * - `sql` roda primeiro; `run` é para o que precisa de código (sempre na mesma transação).
 */
export interface Migration {
  id: string;
  sql?: string;
  run?: (tx: postgres.TransactionSql) => Promise<void>;
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
  {
    id: "0002_import",
    sql: `
      -- Contas e cartões. Do número da conta, guarda só os 4 últimos dígitos e um hash para reconhecê-la.
      create table accounts (
        id          serial primary key,
        kind        text not null check (kind in ('conta', 'cartao')),
        source      text not null,
        key_hash    text not null,
        last4       text,
        name        text not null,
        currency    text not null,
        created_at  timestamptz not null default now(),
        unique (source, key_hash)
      );

      -- Cada arquivo importado.
      create table imports (
        id           serial primary key,
        account_id   integer not null references accounts (id),
        file_name    text not null,
        file_sha256  text not null,
        format       text not null,
        first_date   date,
        last_date    date,
        total        integer not null,
        inserted     integer not null,
        duplicates   integer not null,
        warnings     jsonb not null default '[]',
        created_at   timestamptz not null default now()
      );
      create index imports_file_sha256_idx on imports (file_sha256);

      -- Lançamentos. A impressão digital impede o mesmo lançamento de entrar duas vezes.
      create table transactions (
        id                   bigserial primary key,
        account_id           integer not null references accounts (id),
        import_id            integer not null references imports (id),
        fingerprint          text not null,
        external_id          text,
        date                 date not null,
        amount               bigint not null,
        description          text not null,
        type                 text not null,
        installment_current  smallint,
        installment_total    smallint,
        card_last4           text,
        bank_category        text,
        foreign_amount       bigint,
        foreign_currency     text,
        foreign_rate         text,
        created_at           timestamptz not null default now(),
        unique (account_id, fingerprint)
      );
      create index transactions_account_date_idx on transactions (account_id, date);
      create index transactions_date_idx on transactions (date);
    `,
  },
  contentFingerprint,
];
