import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getIntegration } from "@/lib/integration-registry";
import { getAzureToken, getMSGraphToken } from "@/lib/auth";
import { TL_INSTANCE_RE } from "@/lib/executors";
// import { getWizAccessToken } from "@/lib/wiz-auth";
// (Wiz probe is currently disabled — see route.ts wiz branch below.)
import { getInfosecAccessToken } from "@/lib/infosec-auth";
import { getMcpClient, INFOSEC_LOGIC_APP_URL_ALLOWLIST } from "@/lib/mcp-client";
import { env } from "@/lib/config";
import { getToolSecret } from "@/lib/secrets";

// SECURITY: all outbound probe fetches need a timeout. Node's global
// fetch has no default — without an AbortSignal, a slow/hung upstream
// hangs the route until the App Service kills the slot. 10s is well
// above legitimate handshake latency for any of these integrations.
const PROBE_TIMEOUT_MS = 10_000;

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
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  "wiz": async () => {
    // Wiz integration is currently UNAVAILABLE — see the comment
    // block in web/lib/mcp-servers.ts above the (empty) REGISTRY
    // for the full rationale. Short version: Anthropic's MCP
    // connector only forwards `Authorization: Bearer`, but the
    // Wiz MCP server requires three custom `Wiz-Client-*` headers
    // for service-account auth and rejects OAuth bearers from
    // auth.app.wiz.io with HTTP 401. Probe surfaces this clearly
    // instead of attempting an auth path we know will fail.
    throw new Error(
      "Wiz integration is currently unavailable. Anthropic's API-side MCP connector cannot forward the custom Wiz-Client-* headers required for service-account authentication. The credentials you've configured will be reused when one of the planned re-enable paths lands — see docs/configuration.md.",
    );
  },
  "infosec-incident-response": async () => {
    // Stage 1: Entra ID token. Surfaces credential / audience
    // misconfiguration distinctly from MCP-side reachability errors.
    let token: string;
    try {
      token = await getInfosecAccessToken();
    } catch (err) {
      throw new Error(
        `Infosec authentication failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Stage 2: force the MCP handshake (initialize +
    // notifications/initialized). Doesn't invoke any destructive
    // tool — `ensureSession()` is the dedicated probe hook.
    const mcpUrl = env.INFOSEC_LOGIC_APP_MCP_URL;
    if (!mcpUrl) {
      throw new Error(
        "Missing INFOSEC_LOGIC_APP_MCP_URL — required to reach the Logic App. Configure via /integrations.",
      );
    }
    if (!INFOSEC_LOGIC_APP_URL_ALLOWLIST.has(mcpUrl)) {
      throw new Error(
        `INFOSEC_LOGIC_APP_MCP_URL '${mcpUrl}' is not in the probe allowlist. Today the probe targets the production Logic App URL only; if your tenant uses a different endpoint, extend INFOSEC_LOGIC_APP_URL_ALLOWLIST in mcp-client.ts.`,
      );
    }
    const client = getMcpClient(mcpUrl, {
      type: "bearer",
      tokenFactory: async () => token,
    });
    // Force a fresh handshake so we surface failures on this probe
    // call rather than reusing a cached session from a prior agent
    // turn. `reset()` is non-destructive — just clears the cached
    // session promise; subsequent calls re-handshake.
    client.reset();
    try {
      await client.ensureSession();
    } catch (err) {
      throw new Error(
        `Infosec Logic App handshake failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
