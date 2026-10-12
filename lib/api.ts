import { NextResponse, type NextRequest } from "next/server";
import { HttpError, assertSameOrigin, toHttpError } from "./http";
import { SESSION_COOKIE, currentUser, type Ctx } from "./session";

/** Controlli comuni delle API: stessa origine, utente collegato, corpo JSON; gli errori escono come {error}. */
export async function apiRoute(req: NextRequest, fn: (ctx: Ctx, body: any) => Promise<unknown>) {
  try {
    assertSameOrigin(req);
    const ctx = await currentUser(req.cookies.get(SESSION_COOKIE)?.value);
    if (!ctx) throw new HttpError(401, "non autenticato");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Richiesta non valida");
    }
    const data = await fn(ctx, body);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const err = toHttpError(e);
    return NextResponse.json({ data: null, error: err.message }, { status: err.status, headers: { "Cache-Control": "no-store" } });
  }
}
