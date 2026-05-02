import { NextRequest, NextResponse } from "next/server";
import { resolveAuth, type ResolvedAuth } from "@/lib/auth-helpers";
import {
  getConversation,
  deleteConversation,
  updateTitle,
} from "@/lib/conversation-store";
import { withStoreModeFromRequest } from "@/lib/conversation-store-mode";
import { isLegalHold, LegalHoldViolationError } from "@/lib/retention";
import { logger, hashPii } from "@/lib/logger";
import type { RetentionClass } from "@/lib/types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function rejectLegalHold(
  conversationId: string,
  retentionClass: RetentionClass,
  identity: ResolvedAuth,
  attempted: "delete" | "rename",
): NextResponse {
  logger.emitEvent(
    "legal_hold_violation",
    `Legal hold prevented conversation ${attempted}`,
    "api/conversations",
    {
      conversationId,
      retentionClass,
      ownerIdHash: hashPii(identity.ownerId),
      role: identity.role,
      attempted,
    },
  );
  return NextResponse.json(
    { error: `Conversation is on legal hold and cannot be ${attempted === "delete" ? "deleted" : "renamed"}` },
    { status: 423 },
  );
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withStoreModeFromRequest(request, identity, async () => {
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
  });
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withStoreModeFromRequest(request, identity, async () => {
    const { id } = await params;
    const conv = await getConversation(id, identity.ownerId);

    if (!conv) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    if (conv.ownerId !== identity.ownerId && identity.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (conv.retentionClass && isLegalHold(conv.retentionClass)) {
      return rejectLegalHold(id, conv.retentionClass, identity, "delete");
    }

    try {
      await deleteConversation(id, identity.ownerId);
    } catch (err) {
      if (err instanceof LegalHoldViolationError) {
        return rejectLegalHold(id, err.retentionClass, identity, err.attempted);
      }
      throw err;
    }
    return new Response(null, { status: 204 });
  });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withStoreModeFromRequest(request, identity, async () => {
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

    if (conv.retentionClass && isLegalHold(conv.retentionClass)) {
      return rejectLegalHold(id, conv.retentionClass, identity, "rename");
    }

    try {
      await updateTitle(id, identity.ownerId, title);
    } catch (err) {
      if (err instanceof LegalHoldViolationError) {
        return rejectLegalHold(id, err.retentionClass, identity, err.attempted);
      }
      throw err;
    }
    return NextResponse.json({ id, title });
  });
}
