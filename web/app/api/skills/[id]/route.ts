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

  const skill = getSkill(id);
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

  if (!getSkill(id)) {
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

  try {
    const skill = updateSkill(id, body.content);
    return NextResponse.json({ skill: toSkillMeta(skill) });
  } catch (err) {
    console.error(`[skills] PUT /api/skills/${id} failed:`, err);
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

  if (!getSkill(id)) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  try {
    deleteSkill(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error(`[skills] DELETE /api/skills/${id} failed:`, err);
    return NextResponse.json({ error: "Failed to delete skill" }, { status: 500 });
  }
}
