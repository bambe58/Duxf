-- DuoFin: cancellazione di tutti i dati della famiglia, protetta dalla password di ripristino backup.
-- Cancella movimenti, ricorrenze e quote; con with_cats = true anche categorie e sottocategorie.
-- Restano gli account, i nomi, la password di ripristino e il registro modifiche.
create or replace function public.delete_all_data(pw text, with_cats boolean default false) returns void language plpgsql security definer set search_path = public, extensions as $$
declare h households; hid uuid := my_household();
begin
  select * into h from households where id = hid;
  if h.restore_pw_hash is null then raise exception 'password non impostata'; end if;
  if pw is null or h.restore_pw_hash <> crypt(pw, h.restore_pw_hash) then raise exception 'password errata'; end if;
  perform set_config('duofin.nolog', '1', true);
  delete from transactions where household_id = hid; delete from recurrences where household_id = hid; delete from year_settings where household_id = hid;
  if with_cats then delete from subcategories where household_id = hid; delete from categories where household_id = hid; end if;
  perform set_config('duofin.nolog', '', true);
  insert into audit_log(household_id, user_name, table_name, action, summary, title)
    values (hid, coalesce((select name from profiles where id = auth.uid()), 'Sistema'), 'backup', 'delete',
            case when with_cats then 'Cancellati tutti i dati, categorie comprese' else 'Cancellati tutti i movimenti e le quote' end, 'ha cancellato i dati');
end $$;
revoke execute on function public.delete_all_data(text, boolean) from public, anon;
grant execute on function public.delete_all_data(text, boolean) to authenticated;
