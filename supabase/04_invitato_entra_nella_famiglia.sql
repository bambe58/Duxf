-- Facoltativo: chi viene invitato entra direttamente nella famiglia di chi lo ha invitato
-- quando fa il primo accesso (sceglie la password), senza creare un bilancio vuoto.
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare hid uuid; em text := lower(new.email); nm text; iv invites;
begin
  if exists (select 1 from allowed_emails) and not exists (select 1 from allowed_emails where email = em)
     and not exists (select 1 from invites where lower(to_email) = em) then
    raise exception 'Questo indirizzo non è abilitato';
  end if;
  nm := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(em, '@', 1));
  select * into iv from invites where lower(to_email) = em and (select count(*) from profiles where household_id = invites.household_id) < 2 limit 1;
  if iv.id is not null then
    insert into profiles(id, household_id, name, email) values (new.id, iv.household_id, nm, em);
    delete from invites where lower(to_email) = em;
    return new;
  end if;
  insert into households default values returning id into hid;
  insert into profiles(id, household_id, name, email) values (new.id, hid, nm, em);
  perform _seed_household(hid);
  return new;
end $function$;
