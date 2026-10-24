-- DuoFin: nomi di categorie e sottocategorie sempre in MAIUSCOLO (anche da import, backup e categorie iniziali)
create or replace function public._upper_name() returns trigger language plpgsql as $$
begin new.name := upper(btrim(new.name)); return new; end $$;

drop trigger if exists upper_name on public.categories;
create trigger upper_name before insert or update of name on public.categories for each row execute function public._upper_name();
drop trigger if exists upper_name on public.subcategories;
create trigger upper_name before insert or update of name on public.subcategories for each row execute function public._upper_name();

-- aggiorna i nomi gia' presenti senza riempire il registro modifiche
select set_config('duofin.nolog', '1', true);
update public.categories set name = upper(btrim(name)) where name <> upper(btrim(name));
update public.subcategories set name = upper(btrim(name)) where name <> upper(btrim(name));
select set_config('duofin.nolog', '', true);
