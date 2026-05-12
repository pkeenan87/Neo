import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getIntegration } from "@/lib/integration-registry";
import { getAzureToken, getMSGraphToken } from "@/lib/auth";
import { TL_INSTANCE_RE } from "@/lib/executors";
import { getToolSecret } from "@/lib/secrets";

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
  "threatlocker": async () => {
    const apiKey = await getToolSecret("THREATLOCKER_API_KEY");
    const instance = await getToolSecret("THREATLOCKER_INSTANCE");
    const orgId = await getToolSecret("THREATLOCKER_ORG_ID");
    if (!apiKey || !instance || !orgId) throw new Error("Missing ThreatLocker credentials");
    // SECURITY: `instance` is interpolated directly into the request hostname
    // below. Enforce the strict allowlist defined by TL_INSTANCE_RE so the
    // value can only ever be a plain subdomain label, never a string that
    // could redirect the request — and the API key in the headers — to an
    // attacker-controlled host.
    if (!TL_INSTANCE_RE.test(instance)) {
      throw new Error("Invalid THREATLOCKER_INSTANCE format — expected a short lowercase subdomain label (e.g., 'us' or 'g').");
    }
    const res = await fetch(
      `https://portalapi.${instance}.threatlocker.com/portalapi/ApprovalRequest/ApprovalRequestGetByParameters`,
      {
        method: "POST",
        // SECURITY: refuse to follow redirects so a 3xx from a CDN/edge can never
        // forward `authorization` or `managedOrganizationId` to a redirect target.
        redirect: "error",
        headers: { authorization: apiKey, "Content-Type": "application/json", managedOrganizationId: orgId },
        body: JSON.stringify({ pageSize: 1, statusIds: [1] }),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  "lansweeper": async () => {
    const apiToken = await getToolSecret("LANSWEEPER_API_TOKEN");
    const siteId = await getToolSecret("LANSWEEPER_SITE_ID");
    if (!apiToken || !siteId) throw new Error("Missing Lansweeper credentials");
    // SECURITY: Validate siteId format before use — expected UUID or alphanumeric
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(siteId)) throw new Error("Invalid LANSWEEPER_SITE_ID format");
    const res = await fetch("https://api.lansweeper.com/api/v2/graphql", {
      method: "POST",
      // SECURITY: refuse to follow redirects so a 3xx can never forward the PAT.
      redirect: "error",
      // Lansweeper PATs use "Token" scheme, not "Bearer" (which is for OAuth JWTs)
      headers: { Authorization: `Token ${apiToken}`, "Content-Type": "application/json" },
      // SECURITY: siteId passed as a GraphQL variable, not interpolated into the query string
      body: JSON.stringify({
        query: `query GetSite($id: ID!) { site(id: $id) { name } }`,
        variables: { id: siteId },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(json.errors[0].message);
  },
  "abnormal-security": async () => {
    const apiToken = await getToolSecret("ABNORMAL_API_TOKEN");
    if (!apiToken) throw new Error("Missing Abnormal Security credentials");
    // Use a lightweight GET endpoint to verify credentials
    const res = await fetch("https://api.abnormalplatform.com/v1/threats?pageSize=1&pageNumber=1", {
      // SECURITY: refuse to follow redirects so a 3xx can never forward the bearer token.
      redirect: "error",
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  "wiz": async () => {
    const url = await getToolSecret("WIZ_MCP_URL");
    const token = await getToolSecret("WIZ_MCP_TOKEN");
    if (!url) throw new Error("Missing WIZ_MCP_URL");
    if (!token) throw new Error("Missing WIZ_MCP_TOKEN");
    // SECURITY: only allow https Wiz MCP URLs. Rejecting non-https
    // up front prevents an accidentally-typed http:// URL from
    // sending the bearer token over plaintext during the probe.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("WIZ_MCP_URL is not a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("WIZ_MCP_URL must use https:// (refusing to send bearer token over plaintext)");
    }
    // Cheapest possible auth check — the streamable HTTP MCP
    // transport accepts an OPTIONS request to confirm the server
    // is reachable with the supplied credentials. We deliberately
    // do not run a representative graph query here (per the spec's
    // open-question answer).
    const res = await fetch(url, {
      method: "OPTIONS",
      // SECURITY: refuse to follow redirects so a 3xx can never forward the bearer token.
      redirect: "error",
      headers: { Authorization: `Bearer ${token}` },
    });
    // Some MCP servers return 200, others 204 for an OPTIONS preflight.
    // 401/403 indicates the token is wrong; 5xx indicates the server
    // is unhealthy. Anything else is treated as unreachable.
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Wiz authentication failed (HTTP ${res.status}) — check WIZ_MCP_TOKEN`);
    }
    if (!res.ok && res.status !== 204) {
      throw new Error(`Wiz MCP server returned HTTP ${res.status}`);
    }
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : "";
    console.error(`[integration-probe] ${slug} failed:`, message, cause);
    return NextResponse.json({
      success: false,
      error: `Connection test failed: ${message}${cause}`,
    });
  }
}
