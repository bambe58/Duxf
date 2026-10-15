-- DuoFin: funzioni per accettare un invito e ripristinare un backup.
-- Da incollare nel SQL Editor di Supabase (progetto DuoFin) e premere "Run".

-- Accettare/rifiutare un invito: l'utente entra nella famiglia di chi lo ha invitato (massimo 2 persone).
create or replace function public.answer_invite(id uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles; iv invites;
begin
  select * into me from profiles where profiles.id = auth.uid();
  select * into iv from invites where invites.id = answer_invite.id and lower(to_email) = lower(me.email);
  if iv.id is null then raise exception 'invito non trovato'; end if;
  if accept then
    if (select count(*) from profiles where household_id = me.household_id) > 1 then raise exception 'sei già in una famiglia'; end if;
    if (select count(*) from profiles where household_id = iv.household_id) >= 2 then raise exception 'la famiglia ha già due utenze'; end if;
    update profiles set household_id = iv.household_id, joined_at = now() where profiles.id = me.id;
  end if;
  delete from invites where invites.id = iv.id;
end $$;

-- Ripristino backup: sostituisce i dati della famiglia, solo con la password di ripristino.
create or replace function public.restore_backup(pw text, payload jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare h households; hid uuid := my_household();
begin
  select * into h from households where households.id = hid;
  if h.restore_pw_hash is null then raise exception 'password non impostata'; end if;
  if pw is null or h.restore_pw_hash <> crypt(pw, h.restore_pw_hash) then raise exception 'password errata'; end if;
  perform set_config('duofin.nolog', '1', true);
  delete from transactions where household_id = hid; delete from recurrences where household_id = hid;
  delete from subcategories where household_id = hid; delete from categories where household_id = hid; delete from year_settings where household_id = hid;
  insert into categories(id, household_id, name, color, icon, archived, created_at)
    select b.id, hid, b.name, coalesce(b.color, '#7b8099'), coalesce(b.icon, 'altro'), coalesce(b.archived, false), coalesce(b.created_at, now()) from jsonb_populate_recordset(null::categories, coalesce(payload->'categories', '[]')) b;
  insert into subcategories(id, household_id, category_id, name, archived, created_at)
    select b.id, hid, b.category_id, b.name, coalesce(b.archived, false), coalesce(b.created_at, now()) from jsonb_populate_recordset(null::subcategories, coalesce(payload->'subcategories', '[]')) b;
  insert into recurrences(id, household_id, freq, anchor_date, active, created_at)
    select b.id, hid, b.freq, b.anchor_date, coalesce(b.active, true), coalesce(b.created_at, now()) from jsonb_populate_recordset(null::recurrences, coalesce(payload->'recurrences', '[]')) b;
  insert into transactions(id, household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, payee, note, rec_id, created_at)
    select b.id, hid, b.kind, b.amount_cents, b.tx_date, b.category_id, b.subcategory_id, b.payer, b.payee, coalesce(b.note, ''), b.rec_id, coalesce(b.created_at, now()) from jsonb_populate_recordset(null::transactions, coalesce(payload->'transactions', '[]')) b;
  insert into year_settings(household_id, year, monthly_quota_cents)
    select hid, b.year, b.monthly_quota_cents from jsonb_populate_recordset(null::year_settings, coalesce(payload->'year_settings', '[]')) b;
  perform set_config('duofin.nolog', '', true);
  insert into audit_log(household_id, user_name, table_name, action, summary, title)
    values (hid, coalesce((select name from profiles where id = auth.uid()), 'Sistema'), 'backup', 'insert', 'Ripristino backup eseguito', 'ha ripristinato un backup');
end $$;

revoke execute on function public.answer_invite(uuid, boolean), public.restore_backup(text, jsonb) from public, anon;
grant execute on function public.answer_invite(uuid, boolean), public.restore_backup(text, jsonb) to authenticated;
