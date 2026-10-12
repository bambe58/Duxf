import { NextResponse, type NextRequest } from "next/server";
import { HttpError, assertSameOrigin, toHttpError } from "@/lib/http";
import { isAllowed } from "@/lib/google";
import { passwordLogin, passwordSignup } from "@/lib/login";
import { SESSION_COOKIE, SESSION_MAX_AGE, cookieOptions, signSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    let b: any;
    try {
      b = await req.json();
    } catch {
      throw new HttpError(400, "Richiesta non valida");
    }
    const signup = b?.mode === "signup";
    if (signup && !isAllowed(String(b.email ?? ""))) throw new HttpError(403, "Email non abilitata");
    const uid = signup ? await passwordSignup(b.email, b.name, b.password) : await passwordLogin(b?.email, b?.password);
    const res = NextResponse.json({ error: null }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, await signSession(uid), cookieOptions(SESSION_MAX_AGE));
    return res;
  } catch (e) {
    const err = toHttpError(e);
    return NextResponse.json({ error: err.message }, { status: err.status, headers: { "Cache-Control": "no-store" } });
  }
}
