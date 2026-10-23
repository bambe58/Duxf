-- DuoFin: l'amministratore (firion888@gmail.com) abilita nuove email dall'app (Impostazioni > Utenti abilitati)
alter table public.allowed_emails add column if not exists is_admin boolean not null default false;
update public.allowed_emails set is_admin = true where email = 'firion888@gmail.com';

create or replace function public._is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from allowed_emails a join profiles p on lower(p.email) = a.email where p.id = auth.uid() and a.is_admin) $$;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select public._is_admin() $$;

create or replace function public.admin_allowed_list() returns table(email text, is_admin boolean, registered boolean) language plpgsql stable security definer set search_path = public as $$
begin
  if not _is_admin() then raise exception 'non autorizzato'; end if;
  return query select a.email, a.is_admin, exists (select 1 from profiles p where lower(p.email) = a.email) from allowed_emails a order by a.is_admin desc, a.email;
end $$;

create or replace function public.admin_allow_email(email text) returns void language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(email));
begin
  if not _is_admin() then raise exception 'non autorizzato'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email non valida'; end if;
  insert into allowed_emails(email) values (e) on conflict do nothing;
end $$;

create or replace function public.admin_disallow_email(email text) returns void language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(email));
begin
  if not _is_admin() then raise exception 'non autorizzato'; end if;
  delete from allowed_emails where allowed_emails.email = e and not is_admin and not exists (select 1 from profiles p where lower(p.email) = e);
end $$;

revoke execute on function public._is_admin(), public.is_admin(), public.admin_allowed_list(), public.admin_allow_email(text), public.admin_disallow_email(text) from public, anon;
grant execute on function public.is_admin(), public.admin_allowed_list(), public.admin_allow_email(text), public.admin_disallow_email(text) to authenticated;
