import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import {
  getSkill,
  updateSkill,
  deleteSkill,
  validateSkillId,
  validateSkillContent,
  toSkillMeta,
} from "@/lib/skill-store";
import { getMappingsForSkill } from "@/lib/triage-mapping-store";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { logger, hashPii } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const idError = validateSkillId(id);
  if (idError) {
    return NextResponse.json({ error: idError }, { status: 400 });
  }

  const skill = await getSkill(id);
  if (!skill) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  // Readers cannot access admin-only skills
  if (skill.requiredRole === "admin" && identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ skill });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { id } = await params;
  const idError = validateSkillId(id);
  if (idError) {
    return NextResponse.json({ error: idError }, { status: 400 });
  }

  if (!(await getSkill(id))) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  let body: { content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.content || typeof body.content !== "string") {
    return NextResponse.json({ error: "Missing 'content' field" }, { status: 400 });
  }

  const contentError = validateSkillContent(body.content);
  if (contentError) {
    return NextResponse.json({ error: contentError }, { status: 400 });
  }

  // See POST /api/skills for the rationale on the write-time scan.
  const scan = scanUserInput(body.content, {
    sessionId: "skill-write",
    userId: identity.ownerId,
    role: identity.role,
  });
  if (shouldBlock(scan)) {
    return NextResponse.json(
      { error: "Skill content tripped the prompt-injection guard. Rephrase and retry." },
      { status: 400 },
    );
  }

  try {
    const skill = await updateSkill(id, body.content);
    logger.emitEvent("skill_modified", "Skill updated", "api/skills", {
      skillId: id,
      action: "update",
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
    });
    return NextResponse.json({ skill: toSkillMeta(skill) });
  } catch (err) {
    logger.error("Skill update failed", "api/skills", {
      skillId: id,
      action: "update",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to update skill" }, { status: 400 });
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

  const { id } = await params;
  const idError = validateSkillId(id);
  if (idError) {
    return NextResponse.json({ error: idError }, { status: 400 });
  }

  if (!(await getSkill(id))) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  // Block deletion if any triage mappings reference this skill —
  // orphaning a mapping would silently route the affected alert
  // type to the generic fallback. Return the list of blocking
  // mapping keys so the admin UI can guide the operator to
  // reassign or delete them first.
  //
  // getMappingsForSkill propagates Cosmos errors (it goes through the
  // strict lister) so a transient outage surfaces as a thrown
  // exception here. Fail-closed: better to make the admin retry than
  // to silently allow a destructive delete on a false-empty result.
  let blockingMappings: Awaited<ReturnType<typeof getMappingsForSkill>>;
  try {
    blockingMappings = await getMappingsForSkill(id);
  } catch (err) {
    logger.warn("Skill delete blocked — mapping store unavailable", "api/skills", {
      skillId: id,
      ownerIdHash: hashPii(identity.ownerId),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Could not verify triage mapping references — please retry in a moment." },
      { status: 503 },
    );
  }
  if (blockingMappings.length > 0) {
    logger.warn("Skill delete blocked — triage mappings reference it", "api/skills", {
      skillId: id,
      blockingMappingCount: blockingMappings.length,
      ownerIdHash: hashPii(identity.ownerId),
    });
    return NextResponse.json(
      {
        error: "Skill is referenced by triage mappings — reassign or remove them first.",
        blockingMappings: blockingMappings.map((m) => m.id),
      },
      { status: 409 },
    );
  }

  try {
    await deleteSkill(id);
    logger.emitEvent("skill_modified", "Skill deleted", "api/skills", {
      skillId: id,
      action: "delete",
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
    });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    logger.error("Skill delete failed", "api/skills", {
      skillId: id,
      action: "delete",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to delete skill" }, { status: 500 });
  }
}
