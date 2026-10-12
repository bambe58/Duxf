import { NextResponse, type NextRequest } from "next/server";
import { appOrigin, finishAuth, isAllowed } from "@/lib/google";
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_MAX_AGE, cookieOptions, readState, signSession } from "@/lib/session";
import { ensureUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = appOrigin(req);
  const back = (msg: string) => {
    const r = NextResponse.redirect(`${origin}/?error_description=${encodeURIComponent(msg)}`);
    r.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
    return r;
  };
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("error")) return back("google");
    const saved = await readState(req.cookies.get(OAUTH_COOKIE)?.value);
    const code = url.searchParams.get("code");
    if (!saved || !code || saved.state !== url.searchParams.get("state")) return back("stato");
    const { email, name } = await finishAuth(origin, code, saved.verifier, saved.nonce);
    if (!isAllowed(email)) return back("non abilitato");
    const uid = await ensureUser(email, name);
    const res = NextResponse.redirect(`${origin}/`);
    res.cookies.set(SESSION_COOKIE, await signSession(uid), cookieOptions(SESSION_MAX_AGE));
    res.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
    return res;
  } catch (e) {
    console.error("accesso Google non riuscito", e);
    return back("errore");
  }
}
