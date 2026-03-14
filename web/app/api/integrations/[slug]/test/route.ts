import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getIntegration } from "@/lib/integration-registry";
import { getAzureToken, getMSGraphToken } from "@/lib/auth";

const PROBES: Record<string, () => Promise<void>> = {
  "microsoft-sentinel": async () => {
    await getAzureToken("https://api.loganalytics.io");
  },
  "microsoft-defender-xdr": async () => {
    await getAzureToken("https://api.securitycenter.microsoft.com");
  },
  "microsoft-entra-id": async () => {
    await getMSGraphToken();
  },
};

export async function POST(
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

  const probe = PROBES[slug];
  if (!probe) {
    return NextResponse.json(
      { success: false, error: "No test probe available for this integration" },
      { status: 400 }
    );
  }

  try {
    await probe();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({
      success: false,
      error: "Connection test failed. Verify your credentials are correct.",
    });
  }
}
