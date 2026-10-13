import { db } from "./db";
import { HttpError } from "./http";
import { hashPassword, verifyPassword } from "./password";
import { ensureUser } from "./users";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_FAILS = 8; // tentativi sbagliati ogni 15 minuti per email
const DUMMY = hashPassword("dummy-password-for-timing");

/** Le registrazioni sono chiuse a meno di SIGNUP_OPEN=1. */
export const signupOpen = () => process.env.SIGNUP_OPEN === "1";

export const validPassword = (p: unknown): p is string => typeof p === "string" && p.length >= 8 && p.length <= 200;

export async function tooMany(email: string) {
  const r = await db().query<{ n: number }>("select count(*)::int as n from auth_attempts where email = $1 and at > now() - interval '15 minutes'", [email]);
  if (r.rows[0].n >= MAX_FAILS) throw new HttpError(429, "Troppi tentativi, riprova tra qualche minuto");
}

/** Accesso con email e password. Restituisce l'id utente. */
export async function passwordLogin(emailRaw: unknown, password: unknown): Promise<string> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200 || typeof password !== "string" || password.length > 200) throw new HttpError(400, "Email o password non valide");
  await tooMany(email);
  const r = await db().query<{ id: string; password_hash: string | null }>("select id, password_hash from users where lower(email) = $1", [email]);
  const u = r.rows[0];
  const ok = verifyPassword(password, u?.password_hash ?? DUMMY) && !!u?.password_hash;
  if (!ok) {
    await db().query("insert into auth_attempts (email) values ($1)", [email]);
    throw new HttpError(401, "Email o password errate");
  }
  await db().query("delete from auth_attempts where email = $1", [email]);
  return u.id;
}

/** Crea un nuovo account (e il suo nucleo) con email e password. */
export async function passwordSignup(emailRaw: unknown, nameRaw: unknown, password: unknown): Promise<string> {
  if (!signupOpen()) throw new HttpError(403, "Le registrazioni sono chiuse");
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(400, "Email non valida");
  if (!validPassword(password)) throw new HttpError(400, "La password deve avere almeno 8 caratteri");
  const exists = await db().query("select 1 from users where lower(email) = $1", [email]);
  if (exists.rows.length) throw new HttpError(409, "Esiste già un account con questa email");
  const uid = await ensureUser(email, typeof nameRaw === "string" ? nameRaw : "");
  await db().query("update users set password_hash = $1 where id = $2 and password_hash is null", [hashPassword(password), uid]);
  return uid;
}

/** Tentativi sbagliati su operazioni sensibili (chiave libera, es. "wipe:<utente>"). */
export const recordFail = (key: string) => db().query("insert into auth_attempts (email) values ($1)", [key]);
export const clearFails = (key: string) => db().query("delete from auth_attempts where email = $1", [key]);
