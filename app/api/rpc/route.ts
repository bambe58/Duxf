import type { NextRequest } from "next/server";
import { apiRoute } from "@/lib/api";
import { handleRpc } from "@/lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  return apiRoute(req, (ctx, body) => handleRpc(ctx, String(body?.n ?? ""), body?.a && typeof body.a === "object" ? body.a : {}));
}
