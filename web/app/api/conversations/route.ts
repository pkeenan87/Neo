import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { listConversations } from "@/lib/conversation-store";
import { isChannel } from "@/lib/types";

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // listConversations dispatches internally — returns mock-store results
  // when MOCK_MODE (or Cosmos is unconfigured) and Cosmos results otherwise.
  const channelParam = request.nextUrl.searchParams.get("channel");
  const channel = isChannel(channelParam) ? channelParam : undefined;

  const conversations = await listConversations(identity.ownerId, channel);
  return NextResponse.json({ conversations });
}
