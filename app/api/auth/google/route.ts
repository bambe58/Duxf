import { NextResponse } from "next/server";
import { appOrigin, startAuth } from "@/lib/google";
import { OAUTH_COOKIE, cookieOptions, signState } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = appOrigin(req);
  const a = startAuth(origin);
  const res = NextResponse.redirect(a.url);
  res.cookies.set(OAUTH_COOKIE, await signState({ state: a.state, nonce: a.nonce, verifier: a.verifier }), cookieOptions(600));
  return res;
}
