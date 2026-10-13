import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { db, type Q } from "./db";
import { HttpError } from "./http";
import { addLog } from "./audit";
import type { Ctx } from "./session";

type Row = Record<string, any>;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
// drive.file: l'app vede solo i file che ha creato lei, mai il resto del Drive
const SCOPE = "https://www.googleapis.com/auth/drive.file openid email";
const FOLDER = "DuoFin Backup";
const KEEP = 30; // quanti backup tenere nella cartella

export const driveConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const b64url = (b: Buffer) => b.toString("base64url");

function key() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET mancante");
  return createHash("sha256").update("drive-token:" + s).digest();
}
export function encrypt(text: string) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decrypt(blob: string) {
  const b = Buffer.from(blob, "base64"), d = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export function startDrive(origin: string, loginHint: string) {
  if (!driveConfigured()) throw new HttpError(400, "Google Drive non è ancora configurato");
  const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${origin}/api/drive/callback`,
    response_type: "code",
    scope: SCOPE,
    state,
    access_type: "offline", // serve per avere il token di aggiornamento
    prompt: "consent",
    login_hint: loginHint,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

async function tokenCall(body: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...body }),
  });
  const j = (await r.json().catch(() => ({}))) as Row;
  return { ok: r.ok, j };
}

/** Scambia il codice di Google e salva (cifrato) il token di aggiornamento. */
export async function finishDrive(origin: string, code: string, verifier: string, uid: string) {
  const { ok, j } = await tokenCall({ code, redirect_uri: `${origin}/api/drive/callback`, grant_type: "authorization_code", code_verifier: verifier });
  if (!ok || !j.refresh_token) throw new HttpError(400, "Google non ha concesso l'accesso a Drive");
  if (!String(j.scope ?? "").includes("drive.file")) throw new HttpError(400, "Serve il permesso di salvare file su Drive");
  let email: string | null = null;
  try { email = String(decodeJwt(j.id_token).email ?? "") || null; } catch {}
  await db().query(
    `insert into drive_links (user_id, refresh_token_enc, google_email) values ($1,$2,$3)
     on conflict (user_id) do update set refresh_token_enc = excluded.refresh_token_enc, google_email = excluded.google_email, folder_id = null`,
    [uid, encrypt(j.refresh_token), email],
  );
}

export async function driveStatus(uid: string) {
  const r = (await db().query<Row>("select google_email, last_backup_at, last_file_name from drive_links where user_id = $1", [uid])).rows[0];
  return { configured: driveConfigured(), linked: !!r, email: r?.google_email ?? null, last: r?.last_backup_at ?? null, file: r?.last_file_name ?? null };
}

export async function unlinkDrive(uid: string) {
  const r = (await db().query<Row>("select refresh_token_enc from drive_links where user_id = $1", [uid])).rows[0];
  if (!r) return;
  try { await fetch(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: decrypt(r.refresh_token_enc) }) }); } catch {}
  await db().query("delete from drive_links where user_id = $1", [uid]);
}

/** Contenuto del backup: stesso formato del file .json scaricabile (si può ripristinare con "Ripristina da backup"). */
export async function buildBackup(q: Q, hid: string) {
  const get = async (sql: string) => (await q.query<Row>(sql, [hid])).rows;
  return {
    app: "duofin",
    version: 2,
    exported_at: new Date().toISOString(),
    categories: await get("select id, name, color, icon, archived from categories where household_id = $1 order by created_at"),
    subcategories: await get("select id, category_id, name, archived from subcategories where household_id = $1 order by created_at"),
    transactions: await get("select id, kind, amount_cents, tx_date, category_id, subcategory_id, payer, note, rec_id from transactions where household_id = $1 order by tx_date, created_at"),
    year_settings: await get("select year, monthly_quota_cents from year_settings where household_id = $1 order by year"),
    recurrences: await get("select id, freq, anchor_date, active from recurrences where household_id = $1 order by created_at"),
  };
}

async function accessToken(uid: string, enc: string) {
  const { ok, j } = await tokenCall({ refresh_token: decrypt(enc), grant_type: "refresh_token" });
  if (!ok || !j.access_token) {
    if (j.error === "invalid_grant") {
      await db().query("delete from drive_links where user_id = $1", [uid]);
      throw new HttpError(401, "L'accesso a Google Drive è scaduto: ricollega Drive");
    }
    throw new HttpError(502, "Google Drive non risponde, riprova");
  }
  return j.access_token as string;
}

async function gfetch(url: string, tok: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { authorization: `Bearer ${tok}`, ...(init.headers as Record<string, string> | undefined) } });
  return r;
}

async function ensureFolder(uid: string, tok: string, known: string | null, force = false) {
  if (known && !force) return known;
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await gfetch(`${API}/files?q=${q}&fields=files(id)&spaces=drive`, tok);
  let id = ((await found.json().catch(() => ({}))) as Row).files?.[0]?.id as string | undefined;
  if (!id) {
    const c = await gfetch(`${API}/files?fields=id`, tok, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }) });
    if (!c.ok) throw new HttpError(502, "Non riesco a creare la cartella su Drive");
    id = ((await c.json()) as Row).id as string;
  }
  await db().query("update drive_links set folder_id = $1 where user_id = $2", [id, uid]);
  return id;
}

async function upload(tok: string, folder: string, name: string, content: string) {
  const boundary = "duofin" + randomBytes(8).toString("hex");
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder], mimeType: "application/json" })}\r\n` +
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return gfetch(`${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, tok, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
}

/** Salva un backup completo del nucleo nel Drive collegato dall'utente e tiene solo gli ultimi KEEP file. */
export async function backupToDrive(ctx: Ctx, now = new Date()) {
  const link = (await db().query<Row>("select refresh_token_enc, folder_id, last_backup_at from drive_links where user_id = $1", [ctx.uid])).rows[0];
  if (!link) throw new HttpError(400, "Google Drive non è collegato");
  if (link.last_backup_at && now.getTime() - new Date(link.last_backup_at).getTime() < 15000) throw new HttpError(429, "Backup appena eseguito, attendi qualche secondo");
  const tok = await accessToken(ctx.uid, link.refresh_token_enc);
  const payload = await buildBackup(db(), ctx.hid);
  const content = JSON.stringify(payload);
  const name = `duofin-backup-${now.toISOString().slice(0, 16).replace("T", "_").replace(":", "-")}.json`;
  let folder = await ensureFolder(ctx.uid, tok, link.folder_id);
  let r = await upload(tok, folder, name, content);
  if (r.status === 404) { // cartella eliminata dall'utente: la ricreo
    folder = await ensureFolder(ctx.uid, tok, null, true);
    r = await upload(tok, folder, name, content);
  }
  if (!r.ok) throw new HttpError(502, r.status === 403 ? "Google Drive ha rifiutato il salvataggio (spazio o permessi)" : "Salvataggio su Drive non riuscito");
  const file = (await r.json()) as Row;
  // pulizia: tengo gli ultimi KEEP backup
  try {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const list = await gfetch(`${API}/files?q=${q}&orderBy=createdTime desc&pageSize=200&fields=files(id)`, tok);
    const old = (((await list.json()) as Row).files ?? []).slice(KEEP) as Row[];
    for (const f of old) await gfetch(`${API}/files/${f.id}`, tok, { method: "DELETE" });
  } catch {}
  await db().tx(async (q2) => {
    await q2.query("update drive_links set last_backup_at = $1, last_file_name = $2 where user_id = $3", [now.toISOString(), name, ctx.uid]);
    await addLog(q2, ctx, "backup", "insert", `Backup salvato su Google Drive (${payload.transactions.length} movimenti)`, "ha salvato un backup su Google Drive");
  });
  return { name, link: file.webViewLink ?? null, count: payload.transactions.length };
}
