import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/http";
import { SESSION_COOKIE, cookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
  } catch {
    return NextResponse.json({ error: "Richiesta non consentita" }, { status: 403 });
  }
  const res = NextResponse.json({ error: null });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}
