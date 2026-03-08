import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { listConversations } from "@/lib/conversation-store";
import { env } from "@/lib/config";

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!env.COSMOS_ENDPOINT || env.MOCK_MODE) {
    return NextResponse.json({ conversations: [] });
  }

  const conversations = await listConversations(identity.ownerId);
  return NextResponse.json({ conversations });
}
