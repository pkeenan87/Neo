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

  // Surface persistent storage errors as 500. Without this, the admin
  // sees 200 and walks away while the fleet stays tripped because the
  // Cosmos write never landed.
  try {
    await resetCircuitBreaker();
  } catch (err) {
    logger.error("Triage circuit breaker reset failed", "admin-triage", {
      ownerIdHash: hashPii(identity.ownerId),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to reset circuit breaker — see server logs" },
      { status: 500 },
    );
  }

  logger.info("Triage circuit breaker manually reset", "admin-triage", {
    ownerIdHash: hashPii(identity.ownerId),
  });

  return NextResponse.json({ ok: true });
}
