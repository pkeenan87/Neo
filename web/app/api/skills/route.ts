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

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const skills = getSkillsForRole(identity.role).map(toSkillMeta);
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

  if (getSkill(body.id)) {
    return NextResponse.json({ error: "Skill already exists" }, { status: 409 });
  }

  try {
    const skill = createSkill(body.id, body.content);
    return NextResponse.json({ skill: toSkillMeta(skill) }, { status: 201 });
  } catch (err) {
    console.error(`[skills] POST /api/skills failed:`, err);
    return NextResponse.json({ error: "Failed to create skill" }, { status: 400 });
  }
}
