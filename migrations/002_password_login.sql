-- Accesso con email e password + codice d'invito + limite tentativi.
alter table users add column password_hash text;
alter table invites add column code text;
update invites set code = upper(substr(md5(random()::text || id::text), 1, 8)) where code is null;
alter table invites alter column code set not null;

create table auth_attempts (
  id bigserial primary key,
  email text not null,
  at timestamptz not null default now()
);
create index auth_attempts_idx on auth_attempts (email, at);
