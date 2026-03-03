import { NextRequest, NextResponse } from "next/server";
import { sessionStore } from "@/lib/session-store";

export async function GET() {
  const sessions = sessionStore.list();
  return NextResponse.json({ sessions });
}

export async function DELETE(request: NextRequest) {
  let body: { sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: "Missing 'sessionId'" }, { status: 400 });
  }

  const deleted = sessionStore.delete(body.sessionId);
  if (!deleted) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
