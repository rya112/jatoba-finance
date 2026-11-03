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
  {
    id: "0004_categories",
    sql: `
      create table categories (
        id        serial primary key,
        name      text not null unique,
        kind      text not null check (kind in ('despesa', 'receita', 'movimentacao')),
        position  integer not null
      );

      insert into categories (name, kind, position) values
        ('Moradia', 'despesa', 10),
        ('Contas da casa', 'despesa', 20),
        ('Mercado', 'despesa', 30),
        ('Restaurantes e delivery', 'despesa', 40),
        ('Transporte', 'despesa', 50),
        ('Saúde', 'despesa', 60),
        ('Educação', 'despesa', 70),
        ('Lazer', 'despesa', 80),
        ('Assinaturas', 'despesa', 90),
        ('Compras', 'despesa', 100),
        ('Vestuário', 'despesa', 110),
        ('Cuidados pessoais', 'despesa', 120),
        ('Pets', 'despesa', 130),
        ('Viagens', 'despesa', 140),
        ('Impostos e taxas', 'despesa', 150),
        ('Presentes e doações', 'despesa', 160),
        ('Outros', 'despesa', 170),
        ('Salário', 'receita', 210),
        ('Rendimentos', 'receita', 220),
        ('Reembolsos', 'receita', 230),
        ('Outras receitas', 'receita', 240),
        ('Transferência entre contas', 'movimentacao', 310),
        ('Pagamento de fatura', 'movimentacao', 320),
        ('Aporte em investimento', 'movimentacao', 330),
        ('Resgate de investimento', 'movimentacao', 340);

      -- Regras: "se a descrição contém <pattern>, use <category>". O padrão é guardado
      -- normalizado (maiúsculo, sem acento). Direção e tipo de conta são filtros opcionais.
      create table rules (
        id            serial primary key,
        pattern       text not null,
        direction     text check (direction in ('saida', 'entrada')),
        account_kind  text check (account_kind in ('conta', 'cartao')),
        category_id   integer not null references categories (id) on delete cascade,
        origin        text not null check (origin in ('sistema', 'usuario')),
        created_at    timestamptz not null default now(),
        unique nulls not distinct (pattern, direction, account_kind)
      );

      insert into rules (pattern, direction, account_kind, category_id, origin)
      select r.pattern, r.direction, r.account_kind, c.id, 'sistema'
      from (values
        ('FATURA', 'saida', 'conta', 'Pagamento de fatura'),
        ('PAGAMENTO', 'entrada', 'cartao', 'Pagamento de fatura'),
        ('CDB', 'saida', null, 'Aporte em investimento'),
        ('APLICACAO', 'saida', null, 'Aporte em investimento'),
        ('INVESTIMENTO', 'saida', null, 'Aporte em investimento'),
        ('CDB', 'entrada', null, 'Resgate de investimento'),
        ('RESGATE', 'entrada', null, 'Resgate de investimento'),
        ('SALARIO', 'entrada', null, 'Salário'),
        ('RENDIMENTO', 'entrada', null, 'Rendimentos'),
        ('IOF', 'saida', null, 'Impostos e taxas'),
        ('ANUIDADE', 'saida', null, 'Impostos e taxas'),
        ('TARIFA', 'saida', null, 'Impostos e taxas')
      ) as r(pattern, direction, account_kind, category)
      join categories c on c.name = r.category;

      alter table transactions
        add column clean_description  text,
        add column category_id        integer references categories (id) on delete set null,
        add column category_source    text check (category_source in ('manual', 'regra', 'banco')),
        add column rule_id            integer references rules (id) on delete set null,
        add column reviewed           boolean not null default false;
      create index transactions_category_idx on transactions (category_id);
      create index transactions_pending_review_idx on transactions (date) where not reviewed;
    `,
  },
  {
    id: "0005_duplicates",
    sql: `
      -- duplicate_of: cópia confirmada de outro lançamento. Fica guardada para a impressão digital
      -- continuar barrando reimportações, mas some de listas, revisão e somas.
      -- suspect_of: possível cópia (mesma conta, data e valor, texto diferente), esperando decisão.
      alter table transactions
        add column duplicate_of  bigint references transactions (id) on delete set null,
        add column suspect_of    bigint references transactions (id) on delete set null;
      create index transactions_suspect_idx on transactions (suspect_of) where suspect_of is not null;

      -- Marca como suspeitos os pares que já existem: o mais novo aponta para o mais antigo.
      update transactions n set suspect_of = o.id
      from (
        select distinct on (n.id) n.id as new_id, e.id
        from transactions n
        join transactions e on e.account_id = n.account_id and e.date = n.date and e.amount = n.amount
          and e.import_id < n.import_id and upper(e.description) <> upper(n.description)
        order by n.id, e.id
      ) o
      where n.id = o.new_id;
    `,
  },
];
