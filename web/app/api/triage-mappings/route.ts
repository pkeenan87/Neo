import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getSkill, validateSkillId } from "@/lib/skill-store";
import {
  getAllMappings,
  createMapping,
  getMapping,
  validateMappingKey,
} from "@/lib/triage-mapping-store";
import { logger, hashPii } from "@/lib/logger";

/**
 * Admin-only listing of every triage mapping. Readers don't get to
 * see this surface — the data is operational config rather than
 * something a non-admin role needs.
 */
export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const mappings = await getAllMappings();
  return NextResponse.json({ mappings });
}

/**
 * Create a new triage mapping. Body: { key, skillId }. Validates
 * the key shape, that the skill exists, and that the key isn't
 * already taken before delegating to the store. Emits a structured
 * audit event matching the `skill_modified` shape.
 */
export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  let body: { key?: string; skillId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.key || typeof body.key !== "string") {
    return NextResponse.json({ error: "Missing 'key' field" }, { status: 400 });
  }
  if (!body.skillId || typeof body.skillId !== "string") {
    return NextResponse.json({ error: "Missing 'skillId' field" }, { status: 400 });
  }

  const keyError = validateMappingKey(body.key);
  if (keyError) {
    return NextResponse.json({ error: keyError }, { status: 400 });
  }

  // Validate skillId shape + length BEFORE echoing it back in any
  // response body or passing it to the cache lookup — a megabyte-
  // long string would otherwise be reflected in the JSON error and
  // burned on a doomed Map.get.
  const skillIdError = validateSkillId(body.skillId);
  if (skillIdError) {
    return NextResponse.json({ error: `skillId: ${skillIdError}` }, { status: 400 });
  }

  // Skill must exist on the same instance the admin is talking to.
  // Cross-instance propagation is bounded by the skill cache TTL,
  // so a freshly-created skill might briefly 404 here — the admin
  // should retry within ≤15 seconds. Same window the rest of the
  // system already exposes.
  const skill = await getSkill(body.skillId);
  if (!skill) {
    return NextResponse.json(
      { error: `Skill '${body.skillId}' does not exist` },
      { status: 400 },
    );
  }

  // Pre-read for a friendlier 409. The Cosmos createMappingInCosmos
  // path is also atomic, so this is defence-in-depth rather than the
  // sole guard against duplicate creates.
  const existing = await getMapping(body.key);
  if (existing) {
    return NextResponse.json(
      { error: `Triage mapping for '${body.key}' already exists` },
      { status: 409 },
    );
  }

  try {
    const mapping = await createMapping(body.key, body.skillId, {
      ownerIdHash: hashPii(identity.ownerId),
    });
    logger.emitEvent("triage_mapping_modified", "Triage mapping created", "api/triage-mappings", {
      mappingKey: mapping.id,
      skillId: mapping.skillId,
      action: "create",
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
    });
    return NextResponse.json({ mapping }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Race between the pre-read above and the atomic create — surface
    // as a 409 the same way the pre-read does.
    if (/already exists/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    logger.error("Triage mapping create failed", "api/triage-mappings", {
      mappingKey: body.key,
      action: "create",
      errorMessage: message,
    });
    return NextResponse.json({ error: "Failed to create triage mapping" }, { status: 500 });
  }
}
