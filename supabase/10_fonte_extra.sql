-- DuoFin: "fonte" dei versamenti Extra (chi versa: Farmacia, Nonni, ...). Colonna facoltativa; per Extra serve fonte oppure nota.
alter table public.transactions add column if not exists source text;
alter table public.transactions drop constraint if exists transactions_payer_check;
alter table public.transactions add constraint transactions_payer_check check (
  payer in ('F','M','J') or (payer = 'E' and kind = 'versamento' and (btrim(note) <> '' or btrim(coalesce(source, '')) <> '')));

create or replace function public.restore_backup(pw text, payload jsonb) returns void language plpgsql security definer set search_path = public, extensions as $$
declare h households; hid uuid := my_household();
begin
  select * into h from households where id = hid;
  if h.restore_pw_hash is null then raise exception 'password non impostata'; end if;
  if pw is null or h.restore_pw_hash <> crypt(pw, h.restore_pw_hash) then raise exception 'password errata'; end if;
  perform set_config('duofin.nolog', '1', true);
  delete from transactions where household_id = hid; delete from recurrences where household_id = hid;
  delete from subcategories where household_id = hid; delete from categories where household_id = hid; delete from year_settings where household_id = hid;
  insert into categories(id, household_id, name, color, icon, archived, created_at)
    select id, hid, name, coalesce(color, '#7b8099'), coalesce(icon, 'altro'), coalesce(archived, false), coalesce(created_at, now()) from jsonb_populate_recordset(null::categories, coalesce(payload->'categories', '[]'));
  insert into subcategories(id, household_id, category_id, name, icon, archived, created_at)
    select id, hid, category_id, name, icon, coalesce(archived, false), coalesce(created_at, now()) from jsonb_populate_recordset(null::subcategories, coalesce(payload->'subcategories', '[]'));
  insert into recurrences(id, household_id, freq, anchor_date, active, created_at)
    select id, hid, freq, anchor_date, coalesce(active, true), coalesce(created_at, now()) from jsonb_populate_recordset(null::recurrences, coalesce(payload->'recurrences', '[]'));
  insert into transactions(id, household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, payee, note, source, rec_id, created_at)
    select id, hid, kind, amount_cents, tx_date, category_id, subcategory_id, payer, payee, coalesce(note, ''), nullif(btrim(source), ''), rec_id, coalesce(created_at, now()) from jsonb_populate_recordset(null::transactions, coalesce(payload->'transactions', '[]'));
  insert into year_settings(household_id, year, monthly_quota_cents)
    select hid, year, monthly_quota_cents from jsonb_populate_recordset(null::year_settings, coalesce(payload->'year_settings', '[]'));
  perform set_config('duofin.nolog', '', true);
  insert into audit_log(household_id, user_name, table_name, action, summary, title)
    values (hid, coalesce((select name from profiles where id = auth.uid()), 'Sistema'), 'backup', 'insert', 'Ripristino backup eseguito', 'ha ripristinato un backup');
end $$;
