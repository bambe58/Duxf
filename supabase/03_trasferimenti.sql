-- DuoFin: movimento "trasferimento" (credito tra utenti, oppure dal conto comune a un utente)
-- payer = chi cede (F/M/J), payee = chi riceve (F/M). Nessuna ricorrenza. Eseguire una volta sola.
alter table public.transactions add column if not exists payee text;
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check check (kind in ('spesa','versamento','trasferimento'));
alter table public.transactions drop constraint if exists transactions_payee_check;
alter table public.transactions add constraint transactions_payee_check check (
  case when kind = 'trasferimento' then coalesce(payee in ('F','M') and payee <> payer and rec_id is null, false) else payee is null end);

create or replace function public._dtx(t public.transactions) returns text language sql stable security definer set search_path = public as
$$ select case when t.kind = 'trasferimento' then 'Trasferimento ' || _fm(t.amount_cents) || ' da ' || _who(t.household_id, t.payer) || ' a ' || _who(t.household_id, t.payee)
  when t.kind = 'versamento' then 'Versamento ' || _fm(t.amount_cents) || ' di ' || _who(t.household_id, t.payer)
  else 'Spesa ' || _fm(t.amount_cents) || ' · ' || coalesce((select name from categories where id = t.category_id), '?') || ' › ' || coalesce((select name from subcategories where id = t.subcategory_id), '?') || ' · pagata da ' || _who(t.household_id, t.payer) end
  || ' · ' || _fd(t.tx_date) || case when t.note <> '' then ' · ' || t.note else '' end $$;

-- titolo del log: "un trasferimento" (si modifica solo la riga nn di log_change)
do $$ declare d text; begin
  select pg_get_functiondef('public.log_change()'::regprocedure) into d;
  d := replace(d, $q$case when r->>'kind' = 'spesa' then 'una spesa' else 'un versamento' end$q$,
                  $q$case r->>'kind' when 'spesa' then 'una spesa' when 'trasferimento' then 'un trasferimento' else 'un versamento' end$q$);
  execute d;
end $$;
