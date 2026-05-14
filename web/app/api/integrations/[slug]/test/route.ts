import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getIntegration } from "@/lib/integration-registry";
import { getAzureToken, getMSGraphToken } from "@/lib/auth";
import { TL_INSTANCE_RE } from "@/lib/executors";
import { getWizAccessToken } from "@/lib/wiz-auth";
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
    const clientId = await getToolSecret("WIZ_CLIENT_ID");
    const clientSecret = await getToolSecret("WIZ_CLIENT_SECRET");
    const authUrl = await getToolSecret("WIZ_AUTH_URL");
    const legacyToken = await getToolSecret("WIZ_MCP_TOKEN");
    const configuredMcpUrl = (await getToolSecret("WIZ_MCP_URL"))?.trim();

    // Branch on which credential set is configured. Preferred:
    // service-account OAuth via WIZ_CLIENT_ID + WIZ_CLIENT_SECRET
    // + WIZ_AUTH_URL. Backward-compat: legacy static
    // WIZ_MCP_TOKEN. If neither is configured, fail loudly with
    // a specific message so operators know what to set.
    let bearer: string;
    if (clientId && clientSecret && authUrl) {
      // getWizAccessToken validates the auth URL host + protocol,
      // performs the OAuth exchange, and surfaces a structured
      // error on failure. We rewrap so the probe response can
      // distinguish "OAuth failed" from "MCP reachable but
      // rejected the bearer" downstream.
      try {
        bearer = await getWizAccessToken();
      } catch (err) {
        throw new Error(
          `Wiz authentication failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (legacyToken) {
      bearer = legacyToken;
    } else {
      throw new Error(
        "Missing Wiz credentials. Configure WIZ_CLIENT_ID, WIZ_CLIENT_SECRET, and WIZ_AUTH_URL (service account) — or the legacy WIZ_MCP_TOKEN — via /integrations.",
      );
    }

    // SECURITY: enforce a LITERAL allowlist on the probe URL.
    // CodeQL's `js/request-forgery` rule rejects regex `.test()`
    // as a sanitiser for the host part of an outbound URL — but
    // accepts membership in a Set of literal strings, because
    // the taint analyser can then prove the URL is one of N
    // specific values. The runtime agent-loop path
    // (mcp-servers.ts) still uses the broader WIZ_ALLOWED_HOST_RE
    // regex for flexibility — it doesn't fetch from Neo's code,
    // so it isn't a SSRF sink. The probe IS such a sink, so we
    // pin it to a literal allowlist here. If a tenant ever needs
    // a private MCP host, add it explicitly to WIZ_MCP_PROBE_ALLOWLIST.
    const WIZ_MCP_PROBE_ALLOWLIST = new Set<string>([
      "https://mcp.app.wiz.io",
    ]);
    const mcpUrl = configuredMcpUrl && configuredMcpUrl.length > 0
      ? configuredMcpUrl
      : "https://mcp.app.wiz.io";
    if (!WIZ_MCP_PROBE_ALLOWLIST.has(mcpUrl)) {
      throw new Error(
        `WIZ_MCP_URL '${mcpUrl}' is not in the probe allowlist. Today the probe targets https://mcp.app.wiz.io only; if your tenant uses a private MCP host, extend WIZ_MCP_PROBE_ALLOWLIST in route.ts.`,
      );
    }
    // Cheapest possible auth check — the streamable HTTP MCP
    // transport accepts an OPTIONS request to confirm the server
    // is reachable with the supplied credentials. We deliberately
    // do not run a representative graph query here (per the spec's
    // open-question answer).
    const res = await fetch(mcpUrl, {
      method: "OPTIONS",
      // SECURITY: refuse to follow redirects so a 3xx can never forward the bearer token.
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${bearer}` },
    });
    // Some MCP servers return 200, others 204 for an OPTIONS preflight
    // — both are covered by `res.ok` (the 200-299 range). 401/403
    // indicates the bearer is wrong (which for the OAuth path is
    // strange — it means the freshly-minted access token was
    // rejected, suggesting a clock skew or audience mismatch).
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Wiz MCP server rejected the bearer token (HTTP ${res.status}). For the legacy path, check WIZ_MCP_TOKEN; for the OAuth path, verify WIZ_AUTH_URL and the audience parameter.`,
      );
    }
    if (!res.ok) {
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
