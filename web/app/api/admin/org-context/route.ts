import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getToolSecret, setToolSecret } from "@/lib/secrets";
import { ORG_NAME, clearOrgContextCache } from "@/lib/config";
import { ORG_CONTEXT_MAX_CHARS } from "@/lib/org-context-constants";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const orgContext = await getToolSecret("ORG_CONTEXT") ?? null;
    return NextResponse.json({ orgContext, orgName: ORG_NAME });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to fetch org context", "admin-org-context", {
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to fetch organizational context." },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  // CSRF: fail closed — require Origin header on state-changing requests
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (originHost !== host) {
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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { orgContext } = body as Record<string, unknown>;

  if (typeof orgContext !== "string") {
    return NextResponse.json({ error: "orgContext must be a string" }, { status: 400 });
  }

  if (orgContext.length > ORG_CONTEXT_MAX_CHARS) {
    return NextResponse.json(
      { error: `Organizational context exceeds maximum length (${ORG_CONTEXT_MAX_CHARS} characters)` },
      { status: 400 },
    );
  }

  try {
    await setToolSecret("ORG_CONTEXT", orgContext);
    clearOrgContextCache();
    logger.info("Admin updated organizational context", "admin-org-context", {
      contentLength: orgContext.length,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to save org context", "admin-org-context", {
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to save organizational context. Check server logs." },
      { status: 500 },
    );
  }
}
