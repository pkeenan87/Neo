import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import {
  listApiKeys,
  createApiKey,
  ApiKeyValidationError,
  MAX_API_KEY_LIFETIME_MS,
} from "@/lib/api-key-store";
import { logger } from "@/lib/logger";
import type { Role } from "@/lib/permissions";

const VALID_ROLES = new Set<string>(["admin", "reader"]);
const MAX_LABEL_LENGTH = 128;

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const keys = await listApiKeys(identity.ownerId);
    return NextResponse.json({ keys });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to list API keys", "api-keys", {
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to list API keys. Check server logs." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { label, role, expiresAt } = body;

  if (!label || typeof label !== "string" || label.trim() === "") {
    return NextResponse.json({ error: "Label is required." }, { status: 400 });
  }
  if (label.length > MAX_LABEL_LENGTH) {
    return NextResponse.json(
      { error: `Label must be ${MAX_LABEL_LENGTH} characters or fewer.` },
      { status: 400 }
    );
  }
  if (!role || !VALID_ROLES.has(role)) {
    return NextResponse.json(
      { error: "Role must be 'admin' or 'reader'." },
      { status: 400 }
    );
  }
  if (expiresAt) {
    const expMs = new Date(expiresAt).getTime();
    if (isNaN(expMs) || expMs <= Date.now()) {
      return NextResponse.json(
        { error: "Expiration must be a future date." },
        { status: 400 }
      );
    }
    if (expMs - Date.now() > MAX_API_KEY_LIFETIME_MS) {
      return NextResponse.json(
        { error: "API keys cannot expire more than 2 years from now." },
        { status: 400 }
      );
    }
  }

  try {
    const result = await createApiKey(
      label.trim(),
      role as Role,
      expiresAt ?? null,
      identity.ownerId
    );

    logger.info("API key created", "api-keys", {
      keyId: result.record.id,
      label: result.record.label,
      role: result.record.role,
      createdBy: identity.name,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ApiKeyValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to create API key", "api-keys", {
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to create API key. Check server logs." },
      { status: 500 }
    );
  }
}
