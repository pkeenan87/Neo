import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { resetCircuitBreaker } from "@/lib/triage-circuit-breaker";
import { logger, hashPii } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  resetCircuitBreaker();

  logger.info("Triage circuit breaker manually reset", "admin-triage", {
    ownerIdHash: hashPii(identity.ownerId),
  });

  return NextResponse.json({ ok: true });
}
