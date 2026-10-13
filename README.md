# DuoFin

Bilancio di casa per due persone: spese per categoria e sottocategoria, versamenti mensili, quota e conguaglio di fine anno,
statistiche, spese ricorrenti, registro delle modifiche, backup e ripristino.

Next.js (route API) + Postgres su **Neon** + accesso con **email e password** (Google facoltativo) + hosting su **Vercel**.
L'interfaccia è un unico file statico (`public/app.html`) che parla con le API tramite `public/shim.js`.

## Come funziona

- Ogni persona entra con email e password (o con Google, se configurato). Gli inviti al partner si accettano con un **codice di 8 caratteri** che l'invitante legge nelle Impostazioni e comunica a voce: senza verifica via email è ciò che impedisce a un estraneo di accettare l'invito al posto tuo. Non c'è ancora il recupero password via email. Al primo accesso nasce un **nucleo** (bilancio) con le categorie di partenza.
- Dalle Impostazioni si invia un invito alla seconda email: quando l'altra persona accede con quella email e accetta, le due utenze
  condividono gli stessi dati (ognuna con il proprio tema). Un nucleo ha al massimo due utenze.
- Chi paga è `P1` (utente 1), `P2` (utente 2) o `J` (conto comune). I nomi si cambiano dalle Impostazioni.
- Tutti i dati hanno un `household_id`: le API lo ricavano **solo dalla sessione**, mai dalla richiesta, e le chiavi esterne composte
  impediscono di collegare dati di nuclei diversi.

## Installazione

1. **Database**: crea un progetto Neon (regione Francoforte, `aws-eu-central-1`) ed esegui in ordine `migrations/001_schema.sql` e `migrations/002_password_login.sql`.
2. **Google (facoltativo)**: in Google Cloud Console crea credenziali OAuth di tipo "Applicazione web" e aggiungi come URI di reindirizzamento
   autorizzato `https://<tuo-dominio>/api/auth/callback` (e `http://localhost:3000/api/auth/callback` per lo sviluppo).
3. **Variabili d'ambiente** (vedi `.env.example`): `DATABASE_URL` (stringa *pooled* di Neon), `AUTH_SECRET`
   (`openssl rand -base64 48`), Facoltative: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (abilitano il pulsante Google), `APP_URL`, `ALLOWED_EMAILS`.
4. **Vercel**: importa il repository, imposta le variabili e pubblica.

Sviluppo locale: `npm install`, `.env.local` con le variabili, `npm run dev`.

## Test

`npm test` esegue i test di integrazione su un Postgres in memoria (PGlite) con lo stesso schema di Neon:
isolamento tra nuclei, regole sui movimenti, registro modifiche, ricorrenze, inviti, backup e ripristino.

## Limiti noti

- Il ripristino invia il backup in una sola richiesta: su Vercel il limite è circa 4,5 MB (decine di migliaia di movimenti).
- Gli inviti non inviano email: la seconda persona deve accedere con la stessa email indicata e accettare dalle Impostazioni.
- Gli aggiornamenti dall'altro dispositivo arrivano con un controllo ogni 25 secondi (non in tempo reale).

## Registrazioni e cancellazione totale
- Le registrazioni sono **chiuse** (anche per i nuovi accessi con Google). Per riaprirle imposta `SIGNUP_OPEN=1`.
- "Cancella tutti i dati" richiede due password diverse, verificate sul server: `WIPE_UNLOCK_HASH` (sblocca il pulsante per 10 minuti) e `WIPE_CONFIRM_HASH` (conferma). Sono salvate solo come hash scrypt nelle variabili d'ambiente, mai nel codice.
