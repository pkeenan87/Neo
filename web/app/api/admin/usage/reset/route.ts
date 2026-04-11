import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { resetUserWindow, type UsageWindow } from "@/lib/usage-tracker";
import { logger, hashPii } from "@/lib/logger";

const VALID_WINDOWS = new Set<string>(["two-hour", "weekly"]);

// AAD Object IDs are UUID v4 format
const AAD_OID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  // CSRF: block cross-origin state-changing requests for session-auth callers
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logger.warn("Rejected reset request: invalid JSON body", "admin-usage", {
      ownerIdHash: hashPii(identity.ownerId),
    });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    logger.warn("Rejected reset request: body not an object", "admin-usage", {
      ownerIdHash: hashPii(identity.ownerId),
    });
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { userId, window: windowType } = body as Record<string, unknown>;

  if (typeof userId !== "string" || !AAD_OID_RE.test(userId)) {
    logger.warn("Rejected reset request: missing or invalid userId", "admin-usage", {
      ownerIdHash: hashPii(identity.ownerId),
      userIdType: typeof userId,
    });
    return NextResponse.json({ error: "Missing or invalid userId" }, { status: 400 });
  }
  if (typeof windowType !== "string" || !VALID_WINDOWS.has(windowType)) {
    logger.warn("Rejected reset request: invalid window", "admin-usage", {
      ownerIdHash: hashPii(identity.ownerId),
      targetUserIdHash: hashPii(userId),
    });
    return NextResponse.json(
      { error: "Invalid window parameter" },
      { status: 400 },
    );
  }

  try {
    await resetUserWindow(userId, windowType as UsageWindow);
    logger.info("Admin reset user usage window", "admin-usage", {
      ownerIdHash: hashPii(identity.ownerId),
      targetUserIdHash: hashPii(userId),
      windowType,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to reset user usage", "admin-usage", {
      errorMessage: message,
      targetUserIdHash: hashPii(userId),
    });
    return NextResponse.json(
      { error: "Failed to reset usage. Check server logs." },
      { status: 500 },
    );
  }
}
