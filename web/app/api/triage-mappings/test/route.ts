import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { resolveTriageSkill, GENERIC_SKILL_ID } from "@/lib/triage-dispatch";
import type { TriageSource } from "@/lib/types";

/**
 * Dry-run resolver for the Settings UI's "test mapping" panel. Given
 * a `product` + `alertType`, returns the skill id that would be used
 * if a real triage request arrived with that source, plus a `source`
 * tag so the UI can show whether it came from a configured mapping,
 * the generic fallback, or neither (no skill registered at all).
 *
 * Side-effect free: no triageRuns row, no audit emit, no caller
 * allowlist check. Pure read against the live mapping + skill stores.
 */
export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  let body: { product?: string; alertType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.product || typeof body.product !== "string") {
    return NextResponse.json({ error: "Missing 'product' field" }, { status: 400 });
  }
  if (!body.alertType || typeof body.alertType !== "string") {
    return NextResponse.json({ error: "Missing 'alertType' field" }, { status: 400 });
  }

  // We only need product + alertType to resolve. The other TriageSource
  // fields are unused by the dispatch path — fill in placeholders so the
  // type contract holds without fabricating semantically meaningful values.
  const source = {
    product: body.product,
    alertType: body.alertType,
    severity: "Informational",
    tenantId: "preview",
    alertId: "preview",
    detectionTime: new Date().toISOString(),
  } as unknown as TriageSource;

  const resolved = await resolveTriageSkill(source);

  if (!resolved) {
    return NextResponse.json({
      skillId: null,
      source: "none" as const,
    });
  }

  return NextResponse.json({
    skillId: resolved.skillId,
    source: resolved.skillId === GENERIC_SKILL_ID ? ("generic" as const) : ("mapped" as const),
  });
}
