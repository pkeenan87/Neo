import { NextRequest, NextResponse } from "next/server";
import { sessionStore } from "@/lib/session-factory";
import { resolveAuth } from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Admins see all sessions; readers see only their own
  const sessions =
    identity.role === "admin"
      ? await sessionStore.list()
      : await sessionStore.listForOwner(identity.ownerId);

  return NextResponse.json({ sessions });
}

export async function DELETE(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: "Missing 'sessionId'" }, { status: 400 });
  }

  const session = await sessionStore.get(body.sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Only the session owner or an admin may delete a session
  if (session.ownerId !== identity.ownerId && identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await sessionStore.delete(body.sessionId);
  return NextResponse.json({ deleted: true });
}
