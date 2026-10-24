-- DuoFin: icona facoltativa per le sottocategorie (se manca vale quella della categoria)
alter table public.subcategories add column if not exists icon text;
-- (restore_backup va aggiornata per salvare anche la colonna icon: vedi 01_schema.sql)
