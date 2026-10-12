import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const b64url = (b: Buffer) => b.toString("base64url");

export function appOrigin(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function env(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`${k} non impostata`);
  return v;
}

export function startAuth(origin: string) {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), state, nonce, verifier };
}

export async function finishAuth(origin: string, code: string, verifier: string, nonce: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: `${origin}/api/auth/callback`,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("scambio del codice con Google non riuscito");
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new Error("risposta di Google senza id_token");
  const { payload } = await jwtVerify(id_token, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env("GOOGLE_CLIENT_ID"),
  });
  if (payload.nonce !== nonce) throw new Error("nonce non valido");
  if (payload.email_verified !== true || typeof payload.email !== "string") throw new Error("email non verificata");
  const name = typeof payload.given_name === "string" ? payload.given_name : typeof payload.name === "string" ? payload.name : "";
  return { email: payload.email.toLowerCase(), name };
}

/** Se ALLOWED_EMAILS è impostata, entrano solo quelle email. */
export function isAllowed(email: string): boolean {
  const list = (process.env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !list.length || list.includes(email.toLowerCase());
}
