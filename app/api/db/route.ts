import type { NextRequest } from "next/server";
import { apiRoute } from "@/lib/api";
import { handleDb } from "@/lib/table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  return apiRoute(req, (ctx, body) => handleDb(ctx, body));
}
