import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, currentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const u = await currentUser(req.cookies.get(SESSION_COOKIE)?.value);
    return NextResponse.json({ user: u ? { id: u.uid, name: u.name, email: u.email } : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("sessione", e);
    return NextResponse.json({ user: null }, { status: 500 });
  }
}
