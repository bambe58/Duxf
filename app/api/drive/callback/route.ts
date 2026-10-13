import { NextResponse, type NextRequest } from "next/server";
import { appOrigin } from "@/lib/google";
import { finishDrive } from "@/lib/drive";
import { HttpError } from "@/lib/http";
import { OAUTH_COOKIE, SESSION_COOKIE, cookieOptions, currentUser, readState } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = appOrigin(req);
  const back = (v: string) => {
    const r = NextResponse.redirect(`${origin}/?drive=${encodeURIComponent(v)}`);
    r.cookies.set(OAUTH_COOKIE, "", cookieOptions(0));
    return r;
  };
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("error")) return back("Accesso a Drive annullato");
    const me = await currentUser(req.cookies.get(SESSION_COOKIE)?.value);
    const saved = await readState(req.cookies.get(OAUTH_COOKIE)?.value);
    const code = url.searchParams.get("code");
    if (!me || !saved || saved.purpose !== "drive" || saved.sub !== me.uid || !code || saved.state !== url.searchParams.get("state")) return back("Collegamento non valido, riprova");
    await finishDrive(origin, code, saved.verifier, me.uid);
    return back("ok");
  } catch (e) {
    console.error("collegamento Drive", e);
    return back(e instanceof HttpError ? e.message : "Collegamento a Drive non riuscito");
  }
}
