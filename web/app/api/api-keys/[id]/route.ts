import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { revokeApiKey } from "@/lib/api-key-store";
import { logger } from "@/lib/logger";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (!SHA256_HEX_RE.test(id)) {
    return NextResponse.json({ error: "Invalid key ID." }, { status: 400 });
  }

  try {
    await revokeApiKey(id, identity.ownerId);

    logger.info("API key revoked", "api-keys", {
      keyId: id,
      revokedBy: identity.name,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("Forbidden")) {
      return NextResponse.json({ error: message }, { status: 403 });
    }

    logger.error("Failed to revoke API key", "api-keys", {
      keyId: id,
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to revoke API key. Check server logs." },
      { status: 500 }
    );
  }
}
