import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import {
  getConversation,
  deleteConversation,
  updateTitle,
} from "@/lib/conversation-store";
import { withStoreModeFromRequest } from "@/lib/conversation-store-mode";
import { isLegalHold, LegalHoldViolationError } from "@/lib/retention";
import { logger, hashPii } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
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
      logger.emitEvent(
        "legal_hold_violation",
        "Legal hold prevented conversation delete",
        "api/conversations",
        {
          conversationId: id,
          retentionClass: conv.retentionClass,
          ownerIdHash: hashPii(identity.ownerId),
          role: identity.role,
          attempted: "delete",
        },
      );
      return NextResponse.json(
        { error: "Conversation is on legal hold and cannot be deleted" },
        { status: 423 },
      );
    }

    try {
      await deleteConversation(id, identity.ownerId);
    } catch (err) {
      // Defense-in-depth: if a future caller bypasses the route layer
      // and reaches the store directly, the store throws this same
      // error. Surface it consistently as 423 here too. Use a name
      // check rather than `instanceof` so test boundaries that re-
      // import the class still match (vitest cross-module identity).
      if (err instanceof LegalHoldViolationError || (err as Error)?.name === "LegalHoldViolationError") {
        logger.emitEvent(
          "legal_hold_violation",
          "Legal hold prevented conversation delete (store-layer)",
          "api/conversations",
          {
            conversationId: id,
            retentionClass: conv.retentionClass,
            ownerIdHash: hashPii(identity.ownerId),
            role: identity.role,
            attempted: "delete",
          },
        );
        return NextResponse.json(
          { error: "Conversation is on legal hold and cannot be deleted" },
          { status: 423 },
        );
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

    await updateTitle(id, identity.ownerId, title);
    return NextResponse.json({ id, title });
  });
}
