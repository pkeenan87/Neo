import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getIntegration } from "@/lib/integration-registry";
import { setToolSecret, deleteToolSecret } from "@/lib/secrets";
import { clearTokenCache } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  const body = await request.json();
  const secrets: Record<string, string> = body.secrets ?? {};

  const requiredKeys = integration.secrets
    .filter((s) => s.required)
    .map((s) => s.key);
  const missingKeys = requiredKeys.filter(
    (key) => !secrets[key] || secrets[key].trim() === ""
  );
  if (missingKeys.length > 0) {
    return NextResponse.json(
      { error: `Missing required secrets: ${missingKeys.join(", ")}` },
      { status: 400 }
    );
  }

  const allowedKeys = new Set(integration.secrets.map((s) => s.key));

  try {
    const savedKeys: string[] = [];
    for (const [key, value] of Object.entries(secrets)) {
      if (!allowedKeys.has(key)) continue;
      if (value && value.trim() !== "") {
        await setToolSecret(key, value.trim());
        savedKeys.push(key);
      }
    }

    clearTokenCache();

    logger.info("Integration secrets updated", "integrations", {
      slug,
      secretKeys: savedKeys,
      updatedBy: identity.name,
    });

    return NextResponse.json({ success: true, updated: savedKeys });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to save integration secrets", "integrations", {
      slug,
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to save secrets. Check server logs." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  try {
    const deletedKeys: string[] = [];
    for (const secret of integration.secrets) {
      try {
        await deleteToolSecret(secret.key);
        deletedKeys.push(secret.key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("SecretNotFound") && !msg.includes("404")) {
          logger.error("Failed to delete secret", "integrations", {
            slug,
            key: secret.key,
            errorMessage: msg,
          });
          return NextResponse.json(
            { error: "Failed to delete secrets. Check server logs." },
            { status: 500 }
          );
        }
      }
    }

    logger.info("Integration secrets deleted", "integrations", {
      slug,
      secretKeys: deletedKeys,
      deletedBy: identity.name,
    });

    return NextResponse.json({ success: true, deleted: deletedKeys });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to delete integration secrets", "integrations", {
      slug,
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to delete secrets. Check server logs." },
      { status: 500 }
    );
  }
}
