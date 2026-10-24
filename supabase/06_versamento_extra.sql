-- DuoFin: versamento "Extra" (pagante E): soldi che entrano nel conto comune da una terza persona.
-- Solo per i versamenti, con la nota obbligatoria (chi versa). Eseguire una volta sola.
alter table public.transactions drop constraint if exists transactions_payer_check;
alter table public.transactions add constraint transactions_payer_check check (
  payer in ('F','M','J') or (payer = 'E' and kind = 'versamento' and btrim(note) <> ''));

create or replace function public._who(hid uuid, p text) returns text language sql stable security definer set search_path = public as
$$ select case p when 'E' then 'Extra' when 'J' then (select joint_name from households where id = hid)
  else coalesce((select name from (select name, row_number() over (order by joined_at, created_at) rn from profiles where household_id = hid) m where rn = case p when 'F' then 1 else 2 end), 'Partner') end $$;
