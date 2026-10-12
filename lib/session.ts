import { SignJWT, jwtVerify } from "jose";
import { db, type Q } from "./db";

const prod = process.env.NODE_ENV === "production";
export const SESSION_COOKIE = prod ? "__Host-duofin" : "duofin";
export const OAUTH_COOKIE = prod ? "__Host-duofin-oauth" : "duofin-oauth";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function key() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET mancante o troppo corta (servono almeno 32 caratteri)");
  return new TextEncoder().encode(s);
}

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: prod,
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

export async function signSession(uid: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(key());
}

export async function signState(payload: Record<string, string>) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setExpirationTime("10m").sign(key());
}

export async function readState(token: string | undefined): Promise<Record<string, string> | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload as Record<string, string>;
  } catch {
    return null;
  }
}

export interface Ctx {
  uid: string;
  hid: string;
  slot: number;
  name: string;
  email: string;
}

export async function loadCtx(q: Q, uid: string): Promise<Ctx | null> {
  const { rows } = await q.query<{ id: string; household_id: string; slot: number; name: string; email: string }>(
    "select id, household_id, slot, name, email from users where id = $1",
    [uid],
  );
  const u = rows[0];
  return u ? { uid: u.id, hid: u.household_id, slot: u.slot, name: u.name, email: u.email } : null;
}

/** Legge il cookie di sessione e restituisce l'utente (o null). */
export async function currentUser(cookieValue: string | undefined): Promise<Ctx | null> {
  const p = await readState(cookieValue);
  if (!p || typeof p.sub !== "string") return null;
  return loadCtx(db(), p.sub);
}
