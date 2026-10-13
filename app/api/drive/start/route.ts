import { NextResponse, type NextRequest } from "next/server";
import { appOrigin } from "@/lib/google";
import { startDrive } from "@/lib/drive";
import { HttpError } from "@/lib/http";
import { OAUTH_COOKIE, SESSION_COOKIE, cookieOptions, currentUser, signState } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = appOrigin(req);
  try {
    const me = await currentUser(req.cookies.get(SESSION_COOKIE)?.value);
    if (!me) return NextResponse.redirect(`${origin}/`);
    const { url, state, verifier } = startDrive(origin, me.email);
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_COOKIE, await signState({ purpose: "drive", sub: me.uid, state, verifier }), cookieOptions(600));
    return res;
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "errore";
    return NextResponse.redirect(`${origin}/?drive=${encodeURIComponent(msg)}`);
  }
}
