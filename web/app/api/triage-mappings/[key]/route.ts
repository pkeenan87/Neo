import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getSkill } from "@/lib/skill-store";
import {
  getMapping,
  updateMapping,
  deleteMapping,
  validateMappingKey,
} from "@/lib/triage-mapping-store";
import { logger, hashPii } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ key: string }>;
}

/**
 * Decode the URL-encoded `[key]` segment. Next.js App Router
 * decodes path params automatically in most cases, but the colon
 * separator and the dotted alertType form trip enough URL parsers
 * that we URI-decode defensively to recover the canonical
 * `<product>:<alertType>` form before validation.
 */
function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { key: rawKey } = await params;
  const key = decodeKey(rawKey);

  const keyError = validateMappingKey(key);
  if (keyError) {
    return NextResponse.json({ error: keyError }, { status: 400 });
  }

  const mapping = await getMapping(key);
  if (!mapping) {
    return NextResponse.json({ error: "Triage mapping not found" }, { status: 404 });
  }

  return NextResponse.json({ mapping });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { key: rawKey } = await params;
  const key = decodeKey(rawKey);

  const keyError = validateMappingKey(key);
  if (keyError) {
    return NextResponse.json({ error: keyError }, { status: 400 });
  }

  let body: { skillId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.skillId || typeof body.skillId !== "string") {
    return NextResponse.json({ error: "Missing 'skillId' field" }, { status: 400 });
  }

  const existing = await getMapping(key);
  if (!existing) {
    return NextResponse.json({ error: "Triage mapping not found" }, { status: 404 });
  }

  const skill = await getSkill(body.skillId);
  if (!skill) {
    return NextResponse.json(
      { error: `Skill '${body.skillId}' does not exist` },
      { status: 400 },
    );
  }

  try {
    const mapping = await updateMapping(key, body.skillId, {
      ownerIdHash: hashPii(identity.ownerId),
    });
    logger.emitEvent("triage_mapping_modified", "Triage mapping updated", "api/triage-mappings", {
      mappingKey: key,
      skillId: mapping.skillId,
      action: "update",
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
    });
    return NextResponse.json({ mapping });
  } catch (err) {
    logger.error("Triage mapping update failed", "api/triage-mappings", {
      mappingKey: key,
      action: "update",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to update triage mapping" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { key: rawKey } = await params;
  const key = decodeKey(rawKey);

  const keyError = validateMappingKey(key);
  if (keyError) {
    return NextResponse.json({ error: keyError }, { status: 400 });
  }

  try {
    await deleteMapping(key);
    logger.emitEvent("triage_mapping_modified", "Triage mapping deleted", "api/triage-mappings", {
      mappingKey: key,
      action: "delete",
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
    });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    logger.error("Triage mapping delete failed", "api/triage-mappings", {
      mappingKey: key,
      action: "delete",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to delete triage mapping" }, { status: 500 });
  }
}
