-- DuoFin: schema (versione iniziale; il controllo check_same_household e le funzioni di inviti/backup sono in file a parte o nel database), sicurezza (RLS) e funzioni. Ogni famiglia (household) vede solo i propri dati.
create extension if not exists pgcrypto with schema extensions;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  joint_name text not null default 'Conto comune',
  restore_pw_hash text,                      -- password per ripristinare i backup (hash bcrypt)
  created_at timestamptz not null default now()
);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  email text not null,
  skin text not null default 'classico',
  joined_at timestamptz not null default now(),   -- ordine di ingresso: il primo membro e' "F", il secondo "M"
  created_at timestamptz not null default now()
);
create index on public.profiles(household_id);

-- chi puo' registrarsi (oltre agli invitati). Vuota = chiunque.
create table public.allowed_emails (email text primary key);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_email text not null,
  created_at timestamptz not null default now(),
  unique (from_user, to_email)
);

-- famiglia dell'utente collegato (usata da RLS e dai valori predefiniti)
create function public.my_household() returns uuid
language sql stable security definer set search_path = public as
$$ select household_id from public.profiles where id = auth.uid() $$;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  name text not null, color text not null default '#7b8099', icon text not null default 'altro',
  archived boolean not null default false, created_at timestamptz not null default now()
);
create table public.subcategories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  name text not null, icon text,  -- icona facoltativa: se manca vale quella della categoria
  archived boolean not null default false, created_at timestamptz not null default now()
);
create table public.recurrences (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  freq text not null check (freq in ('w','m','y')),
  anchor_date date not null, active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  kind text not null check (kind in ('spesa','versamento','trasferimento')),
  amount_cents bigint not null check (amount_cents > 0),
  tx_date date not null,
  category_id uuid references public.categories(id) on delete set null,
  subcategory_id uuid references public.subcategories(id) on delete set null,
  payer text not null,
  payee text,  -- solo per i trasferimenti: chi riceve
  note text not null default '',
  rec_id uuid references public.recurrences(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint transactions_payer_check check (payer in ('F','M','J') or (payer = 'E' and kind = 'versamento' and btrim(note) <> '')),
  constraint transactions_payee_check check (case when kind = 'trasferimento' then coalesce(payee in ('F','M') and payee <> payer and rec_id is null, false) else payee is null end)
);
create index on public.transactions(household_id, tx_date);
create unique index transactions_rec_once on public.transactions(rec_id, tx_date) where rec_id is not null;  -- niente doppioni delle ricorrenze
create table public.year_settings (
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  year int not null, monthly_quota_cents bigint not null check (monthly_quota_cents >= 0),
  primary key (household_id, year)
);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  at timestamptz not null default now(),
  user_name text not null, table_name text not null, action text not null,
  summary text not null, title text not null, sys boolean not null default false
);
create index on public.audit_log(household_id, at desc);

-- ---------- sicurezza: ogni tabella visibile solo alla propria famiglia ----------
alter table public.households enable row level security;
alter table public.profiles enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.invites enable row level security;
alter table public.categories enable row level security;
alter table public.subcategories enable row level security;
alter table public.recurrences enable row level security;
alter table public.transactions enable row level security;
alter table public.year_settings enable row level security;
alter table public.audit_log enable row level security;

create policy hh_sel on public.households for select to authenticated using (id = public.my_household());
create policy pr_sel on public.profiles for select to authenticated using (household_id = public.my_household());
create policy au_sel on public.audit_log for select to authenticated using (household_id = public.my_household());
create policy cat_all on public.categories for all to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy sub_all on public.subcategories for all to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy rec_all on public.recurrences for all to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy tx_all on public.transactions for all to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy ys_all on public.year_settings for all to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
-- allowed_emails e invites: nessuna policy = nessun accesso diretto (si passa dalle funzioni)

-- ---------- registro modifiche (scritto dai trigger, mai dal client) ----------
create function public._fm(c bigint) returns text language sql immutable as
$$ select translate(to_char(c / 100.0, 'FM999,999,990.00'), ',.', '.,') || ' €' $$;
create function public._fd(d date) returns text language sql immutable as $$ select to_char(d, 'DD/MM/YYYY') $$;

-- nome di chi ha pagato: F/M = membri in ordine di ingresso, J = conto comune
create function public._who(hid uuid, p text) returns text language sql stable security definer set search_path = public as
$$ select case p when 'E' then 'Extra' when 'J' then (select joint_name from households where id = hid)
  else coalesce((select name from (select name, row_number() over (order by joined_at, created_at) rn from profiles where household_id = hid) m where rn = case p when 'F' then 1 else 2 end), 'Partner') end $$;

create function public._dtx(t public.transactions) returns text language sql stable security definer set search_path = public as
$$ select case when t.kind = 'trasferimento' then 'Trasferimento ' || _fm(t.amount_cents) || ' da ' || _who(t.household_id, t.payer) || ' a ' || _who(t.household_id, t.payee)
  when t.kind = 'versamento' then 'Versamento ' || _fm(t.amount_cents) || ' di ' || _who(t.household_id, t.payer)
  else 'Spesa ' || _fm(t.amount_cents) || ' · ' || coalesce((select name from categories where id = t.category_id), '?') || ' › ' || coalesce((select name from subcategories where id = t.subcategory_id), '?') || ' · pagata da ' || _who(t.household_id, t.payer) end
  || ' · ' || _fd(t.tx_date) || case when t.note <> '' then ' · ' || t.note else '' end $$;

create function public.log_change() returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
        n jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
        r jsonb := coalesce(n, o); hid uuid := (coalesce(n, o)->>'household_id')::uuid;
        sys boolean := coalesce(current_setting('duofin.sys', true), '') = '1';
        s text; t text; uname text; nn text; pn text; d text; l public.transactions;
        fr jsonb := '{"w":"settimanale","m":"mensile","y":"annuale"}';
begin
  if coalesce(current_setting('duofin.nolog', true), '') = '1' then return null; end if;
  if tg_table_name = 'transactions' then
    nn := case r->>'kind' when 'spesa' then 'una spesa' when 'trasferimento' then 'un trasferimento' else 'un versamento' end;
    s := case tg_op when 'INSERT' then 'Aggiunta: ' || _dtx(new) when 'DELETE' then 'Eliminata: ' || _dtx(old)
         else 'Modificata: ' || _dtx(old) || '  →  ' || _dtx(new) end;
    t := case when sys then 'È stato registrato un movimento ricorrente' else case tg_op when 'INSERT' then 'ha aggiunto ' when 'DELETE' then 'ha eliminato ' else 'ha modificato ' end || nn end;
    if sys then s := 'Ricorrente registrata: ' || _dtx(new); end if;
  elsif tg_table_name = 'categories' then
    s := case when tg_op = 'INSERT' then 'Categoria creata: ' || (n->>'name') when tg_op = 'DELETE' then 'Categoria eliminata: ' || (o->>'name')
         when o->>'name' <> n->>'name' then 'Categoria rinominata: ' || (o->>'name') || ' → ' || (n->>'name')
         when o->>'archived' <> n->>'archived' then case when (n->>'archived')::boolean then 'Categoria archiviata: ' else 'Categoria ripristinata: ' end || (n->>'name')
         else 'Categoria modificata: ' || (n->>'name') end;
    t := case when tg_op = 'INSERT' then 'ha creato la categoria ' || (n->>'name') when tg_op = 'DELETE' then 'ha eliminato la categoria ' || (o->>'name')
         when o->>'name' <> n->>'name' then 'ha rinominato la categoria ' || (o->>'name')
         when o->>'archived' <> n->>'archived' then case when (n->>'archived')::boolean then 'ha archiviato la categoria ' else 'ha ripristinato la categoria ' end || (n->>'name')
         else 'ha modificato la categoria ' || (n->>'name') end;
  elsif tg_table_name = 'subcategories' then
    pn := coalesce((select name from categories where id = (r->>'category_id')::uuid), '?');
    s := case when tg_op = 'INSERT' then 'Sottocategoria creata: ' || pn || ' › ' || (n->>'name') when tg_op = 'DELETE' then 'Sottocategoria eliminata: ' || pn || ' › ' || (o->>'name')
         when o->>'name' <> n->>'name' then 'Sottocategoria rinominata: ' || pn || ' › ' || (o->>'name') || ' → ' || (n->>'name')
         when o->>'archived' <> n->>'archived' then case when (n->>'archived')::boolean then 'Sottocategoria archiviata: ' else 'Sottocategoria ripristinata: ' end || pn || ' › ' || (n->>'name')
         else 'Sottocategoria modificata' end;
    t := case when tg_op = 'INSERT' then 'ha creato la sottocategoria ' || (n->>'name') when tg_op = 'DELETE' then 'ha eliminato la sottocategoria ' || (o->>'name')
         when o->>'name' <> n->>'name' then 'ha rinominato la sottocategoria ' || (o->>'name')
         when o->>'archived' <> n->>'archived' then case when (n->>'archived')::boolean then 'ha archiviato la sottocategoria ' else 'ha ripristinato la sottocategoria ' end || (n->>'name')
         else 'ha modificato una sottocategoria' end;
  elsif tg_table_name = 'recurrences' then
    select * into l from transactions where rec_id = (r->>'id')::uuid order by tx_date desc, created_at desc limit 1;
    d := case when l.id is null then '' else _dtx(l) end;
    if tg_op = 'INSERT' then s := 'Ricorrenza ' || (fr->>(n->>'freq')) || ' attivata, dal ' || _fd((n->>'anchor_date')::date); t := 'ha reso ricorrente un movimento (' || (fr->>(n->>'freq')) || ')';
    elsif tg_op = 'DELETE' then s := 'Ricorrenza eliminata'; t := 'ha eliminato una ricorrenza';
    elsif (o->>'active')::boolean and not (n->>'active')::boolean then s := 'Ricorrenza terminata: ' || d; t := 'ha terminato una ricorrenza';
    elsif not (o->>'active')::boolean and (n->>'active')::boolean then s := 'Ricorrenza riattivata (' || (fr->>(n->>'freq')) || '): ' || d; t := 'ha riattivato una ricorrenza';
    elsif o->>'freq' <> n->>'freq' then s := 'Frequenza ' || (fr->>(o->>'freq')) || ' → ' || (fr->>(n->>'freq')) || ': ' || d; t := 'ha cambiato la frequenza di una ricorrenza';
    else s := 'Ricorrenza modificata: ' || d; t := 'ha modificato una ricorrenza'; end if;
  else  -- year_settings
    s := case when tg_op = 'INSERT' then 'Quota ' || (n->>'year') || ' impostata a ' || _fm((n->>'monthly_quota_cents')::bigint) || ' al mese'
         when tg_op = 'DELETE' then 'Quota ' || (o->>'year') || ' rimossa'
         else 'Quota ' || (n->>'year') || ': ' || _fm((o->>'monthly_quota_cents')::bigint) || ' → ' || _fm((n->>'monthly_quota_cents')::bigint) || ' al mese' end;
    t := case when tg_op = 'DELETE' then 'ha rimosso la quota ' || (o->>'year') else 'ha impostato la quota ' || (n->>'year') end;
  end if;
  if tg_op = 'UPDATE' and o = n then return null; end if;
  uname := case when sys then 'Sistema' else coalesce((select name from profiles where id = auth.uid()), 'Sistema') end;
  insert into audit_log(household_id, user_name, table_name, action, summary, title, sys)
  values (hid, uname, tg_table_name, lower(tg_op), s, t, sys);
  return null;
end $$;

create trigger log_tx after insert or update or delete on public.transactions for each row execute function public.log_change();
create trigger log_cat after insert or update or delete on public.categories for each row execute function public.log_change();
create trigger log_sub after insert or update or delete on public.subcategories for each row execute function public.log_change();
create trigger log_rec after insert or update or delete on public.recurrences for each row execute function public.log_change();
create trigger log_ys after insert or update or delete on public.year_settings for each row execute function public.log_change();

-- ---------- nuova famiglia: categorie di partenza ----------
create function public._seed_household(hid uuid) returns void language plpgsql security definer set search_path = public as $$
declare c record; cid uuid;
begin
  perform set_config('duofin.nolog', '1', true);
  for c in select * from (values ('Casa','#3d6bff','casa',array['Affitto / mutuo','Utenze']),('Spesa','#12b5a0','spesa',array['Supermercato']),
      ('Trasporti','#8b5cf6','trasporti',array['Carburante']),('Ristorante','#ffb020','ristorante',array['Cene fuori']),('Altro','#7b8099','altro',array['Varie'])) v(n, col, ic, subs) loop
    insert into categories(household_id, name, color, icon) values (hid, c.n, c.col, c.ic) returning id into cid;
    insert into subcategories(household_id, category_id, name) select hid, cid, unnest(c.subs);
  end loop;
  perform set_config('duofin.nolog', '', true);
end $$;

-- ---------- nuovo utente (email o Google): controlla chi puo' entrare, crea famiglia e profilo ----------
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare hid uuid; em text := lower(new.email); nm text;
begin
  if exists (select 1 from allowed_emails) and not exists (select 1 from allowed_emails where email = em)
     and not exists (select 1 from invites where lower(to_email) = em) then
    raise exception 'Questo indirizzo non è abilitato';
  end if;
  nm := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(em, '@', 1));
  insert into households default values returning id into hid;
  insert into profiles(id, household_id, name, email) values (new.id, hid, nm, em);
  perform _seed_household(hid);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- funzioni chiamate dall'app ----------
create function public.is_member() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid()) $$;

create function public.get_profile() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'skin', p.skin, 'joint', h.joint_name, 'has_pw', h.restore_pw_hash is not null,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email) order by m.joined_at, m.created_at), '[]') from profiles m where m.household_id = p.household_id),
    'invites_in', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'from_name', f.name, 'from_email', f.email)), '[]') from invites i join profiles f on f.id = i.from_user where lower(i.to_email) = lower(p.email)),
    'invites_out', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'to', i.to_email)), '[]') from invites i where i.from_user = p.id))
  from profiles p join households h on h.id = p.household_id where p.id = auth.uid() $$;

create function public.set_skin(skin text) returns void language sql security definer set search_path = public as
$$ update profiles set skin = set_skin.skin where id = auth.uid() $$;

create function public.set_joint_name(name text) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(name), '') = '' then raise exception 'nome vuoto'; end if;
  update households set joint_name = trim(name) where id = my_household();
end $$;

create function public.invite_partner(email text) returns void language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(email)); me profiles; t profiles;
begin
  select * into me from profiles where id = auth.uid();
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email non valida'; end if;
  if e = lower(me.email) then raise exception 'è la tua stessa email'; end if;
  if (select count(*) from profiles where household_id = me.household_id) >= 2 then raise exception 'la famiglia ha già due utenze'; end if;
  if exists (select 1 from invites where from_user = me.id and lower(to_email) = e) then raise exception 'invito già inviato'; end if;
  select * into t from profiles where lower(profiles.email) = e;
  if t.id is not null and (select count(*) from profiles where household_id = t.household_id) > 1 then raise exception 'questa utenza è già collegata a un''altra famiglia'; end if;
  insert into invites(household_id, from_user, to_email) values (me.household_id, me.id, e);
end $$;

create function public.cancel_invite(id uuid) returns void language sql security definer set search_path = public as
$$ delete from invites where invites.id = cancel_invite.id and from_user = auth.uid() $$;

create function public.answer_invite(id uuid, accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare me profiles; iv invites; old uuid;
begin
  select * into me from profiles where profiles.id = auth.uid();
  select * into iv from invites where invites.id = answer_invite.id and lower(to_email) = lower(me.email);
  if iv.id is null then raise exception 'invito non trovato'; end if;
  delete from invites where invites.id = iv.id;
  if not accept then return; end if;
  if (select count(*) from profiles where household_id = me.household_id) > 1 then raise exception 'sei già in una famiglia'; end if;
  if (select count(*) from profiles where household_id = iv.household_id) >= 2 then raise exception 'la famiglia ha già due utenze'; end if;
  old := me.household_id;
  perform set_config('duofin.nolog', '1', true);
  update profiles set household_id = iv.household_id, joined_at = now() where profiles.id = me.id;
  delete from invites where household_id = old;
  delete from households where households.id = old;       -- la famiglia vuota e i suoi dati di partenza spariscono
  perform set_config('duofin.nolog', '', true);
end $$;

create function public.set_restore_password(old text, new text) returns void language plpgsql security definer set search_path = public, extensions as $$
declare h households;
begin
  select * into h from households where id = my_household();
  if h.restore_pw_hash is not null and (old is null or h.restore_pw_hash <> crypt(old, h.restore_pw_hash)) then raise exception 'password attuale errata'; end if;
  if length(coalesce(new, '')) < 6 then raise exception 'almeno 6 caratteri'; end if;
  update households set restore_pw_hash = crypt(new, gen_salt('bf')) where id = h.id;
end $$;

create function public.restore_backup(pw text, payload jsonb) returns void language plpgsql security definer set search_path = public, extensions as $$
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
  insert into transactions(id, household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, payee, note, rec_id, created_at)
    select id, hid, kind, amount_cents, tx_date, category_id, subcategory_id, payer, payee, coalesce(note, ''), rec_id, coalesce(created_at, now()) from jsonb_populate_recordset(null::transactions, coalesce(payload->'transactions', '[]'));
  insert into year_settings(household_id, year, monthly_quota_cents)
    select hid, year, monthly_quota_cents from jsonb_populate_recordset(null::year_settings, coalesce(payload->'year_settings', '[]'));
  perform set_config('duofin.nolog', '', true);
  insert into audit_log(household_id, user_name, table_name, action, summary, title)
    values (hid, coalesce((select name from profiles where id = auth.uid()), 'Sistema'), 'backup', 'insert', 'Ripristino backup eseguito', 'ha ripristinato un backup');
end $$;

-- ---------- ricorrenze: un movimento identico a ogni scadenza ----------
-- k-esima data dopo l'ancora; il giorno del mese resta quello di partenza (31 -> ultimo giorno del mese)
create function public.rec_date(anchor date, freq text, k int) returns date language sql immutable as $$
  select case when freq = 'w' then anchor + 7 * k
    else (m + (least(extract(day from anchor)::int, extract(day from (m + interval '1 month - 1 day'))::int) - 1) * interval '1 day')::date end
  from (select date_trunc('month', anchor::timestamp) + (case when freq = 'y' then 12 * k else k end) * interval '1 month' as m) x $$;

create function public._run_rec(hid uuid) returns int language plpgsql security definer set search_path = public as $$
declare r recurrences; l transactions; k int; d date; made int := 0; cnt int;
        today date := (now() at time zone 'Europe/Rome')::date;
begin
  perform set_config('duofin.sys', '1', true);
  for r in select * from recurrences where household_id = hid and active loop
    select * into l from transactions where rec_id = r.id order by tx_date desc, created_at desc limit 1;
    if l.id is null then continue; end if;
    cnt := 0;
    for k in 1..800 loop
      d := rec_date(r.anchor_date, r.freq, k);
      exit when d > today or cnt >= 60;
      if d > l.tx_date then
        insert into transactions(household_id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id)
        values (hid, l.kind, l.amount_cents, d, l.category_id, l.subcategory_id, l.payer, l.note, r.id) on conflict do nothing;
        cnt := cnt + 1; made := made + 1;
      end if;
    end loop;
  end loop;
  perform set_config('duofin.sys', '', true);
  return made;
end $$;
-- chiamata dall'app all'avvio: lavora solo sulla famiglia dell'utente
create function public.run_recurrences() returns int language sql security definer set search_path = public as $$ select _run_rec(my_household()) $$;
-- chiamata ogni giorno dal job pianificato: tutte le famiglie
create function public.run_recurrences_all() returns int language plpgsql security definer set search_path = public as $$
declare h uuid; n int := 0;
begin for h in select id from households loop n := n + _run_rec(h); end loop; return n; end $$;

-- ---------- permessi: le funzioni interne non sono chiamabili dall'app ----------
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.my_household(), public.is_member(), public.get_profile(), public.set_skin(text), public.set_joint_name(text),
  public.invite_partner(text), public.cancel_invite(uuid), public.answer_invite(uuid, boolean), public.set_restore_password(text, text),
  public.restore_backup(text, jsonb), public.run_recurrences() to authenticated;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.categories, public.subcategories, public.recurrences, public.transactions, public.year_settings to authenticated;
grant select on public.audit_log, public.profiles, public.households to authenticated;

-- aggiornamenti in tempo reale tra i due telefoni
alter publication supabase_realtime add table public.categories, public.subcategories, public.recurrences, public.transactions, public.year_settings;

-- nomi di categorie e sottocategorie sempre in MAIUSCOLO
create or replace function public._upper_name() returns trigger language plpgsql as $$
begin new.name := upper(btrim(new.name)); return new; end $$;

drop trigger if exists upper_name on public.categories;
create trigger upper_name before insert or update of name on public.categories for each row execute function public._upper_name();
drop trigger if exists upper_name on public.subcategories;
create trigger upper_name before insert or update of name on public.subcategories for each row execute function public._upper_name();
