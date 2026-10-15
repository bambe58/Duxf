# DuoFin

Bilancio di casa in due. App statica (HTML + JS) con database Supabase.

- `index.html` l'app · `config.js` URL e chiave pubblica di Supabase · `vercel.json` intestazioni di sicurezza
- `supabase/01_schema.sql` schema di riferimento (già applicato, con in più il controllo di coerenza tra famiglie)
- `supabase/03_trasferimenti.sql` movimento «trasferimento» (già applicato al progetto DuoFin; serve solo a chi ha un database creato prima)
- `supabase/02_inviti_e_backup.sql` da eseguire nel SQL Editor di Supabase (accettare inviti, ripristino backup)

## Pubblicazione
1. Carica questi file nel repository GitHub, nella radice. Vercel pubblica da solo a ogni modifica.
2. In Vercel: Framework "Other", nessun comando di build, cartella di output vuota.
3. In Supabase → Authentication → URL Configuration: Site URL = indirizzo Vercel; aggiungilo anche tra i Redirect URLs.
4. Per il login con Google: credenziali OAuth in Google Cloud, poi Authentication → Providers → Google.
