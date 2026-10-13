-- Collegamento a Google Drive per i backup (token di aggiornamento cifrato lato server).
create table drive_links (
  user_id uuid primary key references users(id) on delete cascade,
  refresh_token_enc text not null,
  google_email text,
  folder_id text,
  last_backup_at timestamptz,
  last_file_name text,
  created_at timestamptz not null default now()
);
