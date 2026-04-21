import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import {
  getConversation,
  deleteConversation,
  updateTitle,
} from "@/lib/conversation-store";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

const { id } = await params;
  const conv = await getConversation(id, identity.ownerId);

  if (!conv) {
    // If admin, try cross-partition (not implemented for simplicity — admin
    // should use the list endpoint)
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  if (conv.ownerId !== identity.ownerId && identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(conv);
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

const { id } = await params;
  const conv = await getConversation(id, identity.ownerId);

  if (!conv) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  if (conv.ownerId !== identity.ownerId && identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await deleteConversation(id, identity.ownerId);
  return new Response(null, { status: 204 });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

const { id } = await params;

  let body: { title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "Missing 'title' field" }, { status: 400 });
  }

  const MAX_TITLE_LENGTH = 200;
  const title = body.title.trim().slice(0, MAX_TITLE_LENGTH);
  if (title.length === 0) {
    return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
  }

  const conv = await getConversation(id, identity.ownerId);
  if (!conv) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  if (conv.ownerId !== identity.ownerId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await updateTitle(id, identity.ownerId, title);
  return NextResponse.json({ id, title });
}
