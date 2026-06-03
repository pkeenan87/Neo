import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import {
  getSkillsForRole,
  createSkill,
  getSkill,
  validateSkillId,
  validateSkillContent,
  toSkillMeta,
} from "@/lib/skill-store";
import { assertParseRoundTrip, parseSkillMarkdown } from "@/lib/skill-parser";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { logger, hashPii } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const skills = (await getSkillsForRole(identity.role)).map(toSkillMeta);
  return NextResponse.json({ skills });
}

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  let body: { id?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "Missing 'id' field" }, { status: 400 });
  }

  if (!body.content || typeof body.content !== "string") {
    return NextResponse.json({ error: "Missing 'content' field" }, { status: 400 });
  }

  const idError = validateSkillId(body.id);
  if (idError) {
    return NextResponse.json({ error: idError }, { status: 400 });
  }

  const contentError = validateSkillContent(body.content);
  if (contentError) {
    return NextResponse.json({ error: contentError }, { status: 400 });
  }

  if (await getSkill(body.id)) {
    return NextResponse.json({ error: "Skill already exists" }, { status: 409 });
  }

  // Admin-authored skill content is interpolated into the system
  // prompt verbatim by the agent loop. Scan for prompt-injection
  // patterns at write time so admin authorship doesn't bypass the
  // guard the rest of the project applies to user input. In default
  // monitor mode this only logs; only INJECTION_GUARD_MODE=block
  // with the existing block-threshold rejects.
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

  // Defence against section-injection: parse the content, then assert
  // that re-serializing produces an identical Skill. A drift means a
  // free-text field (Description / Steps) smuggled a `## Required
  // Role` heading that shadows the legit section via the parser's
  // first-match semantics. Reject these writes so the form widgets
  // remain the source of truth for requiredRole / requiredTools.
  const parsedForCheck = parseSkillMarkdown(body.id, body.content);
  const rt = assertParseRoundTrip(parsedForCheck);
  if (!rt.ok) {
    return NextResponse.json(
      { error: `Skill content rejected: ${rt.reason}` },
      { status: 400 },
    );
  }

  try {
    const skill = await createSkill(body.id, body.content);
    logger.emitEvent("skill_modified", "Skill created", "api/skills", {
      skillId: skill.id,
      action: "create",
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
      // Forensics: parsed role + tools snapshot + content hash so a
      // role downgrade caused by the parser-shadowing vector (or any
      // future regression) is detectable in SIEM without re-fetching
      // the document.
      parsedRequiredRole: skill.requiredRole,
      parsedRequiredToolsCount: skill.requiredTools.length,
      parsedRequiredTools: [...skill.requiredTools].sort().join(","),
      contentHash: createHash("sha256").update(body.content).digest("hex"),
    });
    return NextResponse.json({ skill: toSkillMeta(skill) }, { status: 201 });
  } catch (err) {
    logger.error("Skill create failed", "api/skills", {
      skillId: body.id,
      action: "create",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Failed to create skill" }, { status: 400 });
  }
}
