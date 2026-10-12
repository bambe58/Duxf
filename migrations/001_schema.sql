-- DuoFin: schema Postgres (Neon). Ogni riga di dati appartiene a un nucleo (household).
-- Chi ha pagato: P1 = utente con slot 1, P2 = utente con slot 2, J = conto comune.

create table households (
  id uuid primary key default gen_random_uuid(),
  joint_name text not null default 'Conto comune',
  backup_password_hash text,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  email text not null,
  name text not null,
  slot smallint not null check (slot in (1,2)),
  skin text not null default 'salvia',
  created_at timestamptz not null default now(),
  unique (household_id, slot),
  unique (household_id, id)
);
create unique index users_email_uq on users (lower(email));

create table invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  email text not null,
  invited_by uuid references users(id) on delete set null,
  used boolean not null default false,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now()
);
create unique index invites_open_uq on invites (household_id, lower(email)) where used = false;
create index invites_email_idx on invites (lower(email));

create table categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  color text not null default '#7b8099',
  icon text not null default 'altro',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (household_id, id)
);
create unique index categories_name_uq on categories (household_id, lower(name));

create table subcategories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  category_id uuid not null,
  name text not null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, category_id) references categories (household_id, id) on delete cascade
);
create unique index subcategories_name_uq on subcategories (household_id, category_id, lower(name));

create table recurrences (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  freq text not null check (freq in ('w','m','y')),
  anchor_date date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (household_id, id)
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  kind text not null check (kind in ('spesa','versamento')),
  amount_cents bigint not null check (amount_cents > 0),
  tx_date date not null,
  category_id uuid,
  subcategory_id uuid,
  payer text not null check (payer in ('P1','P2','J')),
  note text not null default '',
  rec_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, category_id) references categories (household_id, id),
  foreign key (household_id, subcategory_id) references subcategories (household_id, id),
  foreign key (household_id, rec_id) references recurrences (household_id, id) on delete set null (rec_id),
  check (
    (kind = 'spesa' and category_id is not null and subcategory_id is not null)
    or (kind = 'versamento' and category_id is null and subcategory_id is null and payer in ('P1','P2'))
  )
);
create index transactions_date_idx on transactions (household_id, tx_date desc);
create index transactions_cat_idx on transactions (household_id, category_id, subcategory_id);
create index transactions_rec_idx on transactions (household_id, rec_id);
-- evita che due dispositivi registrino lo stesso movimento ricorrente nello stesso giorno
create unique index transactions_rec_date_uq on transactions (household_id, rec_id, tx_date) where rec_id is not null;
comment on column transactions.payer is 'P1 = utente con slot 1, P2 = utente con slot 2, J = conto comune';

create table year_settings (
  household_id uuid not null references households(id) on delete cascade,
  year int not null check (year between 2000 and 2100),
  monthly_quota_cents bigint not null check (monthly_quota_cents >= 0),
  primary key (household_id, year)
);

create table audit_log (
  id bigserial primary key,
  household_id uuid not null references households(id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid references users(id) on delete set null,
  user_name text not null,
  table_name text not null,
  action text not null check (action in ('insert','update','delete')),
  summary text not null,
  title text not null,
  sys boolean not null default false
);
create index audit_log_idx on audit_log (household_id, at desc);
