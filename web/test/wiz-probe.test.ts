import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the route's dependencies. The probe lives at
// web/app/api/integrations/[slug]/test/route.ts and we test only
// the `wiz` branch here. Auth and integration-registry mocks
// mirror the patterns used by web/test/triage-mappings-route.test.ts.

const {
  resolveAuthMock,
  fetchMock,
  secretsState,
  getWizAccessTokenMock,
} = vi.hoisted(() => ({
  resolveAuthMock: vi.fn(),
  fetchMock: vi.fn(),
  secretsState: {} as Record<string, string | undefined>,
  getWizAccessTokenMock: vi.fn<() => Promise<string>>(),
}));

vi.mock("../lib/auth-helpers", () => ({
  resolveAuth: () => resolveAuthMock(),
}));

vi.mock("../lib/integration-registry", async () => {
  const actual = await vi.importActual<typeof import("../lib/integration-registry")>(
    "../lib/integration-registry",
  );
  return actual;
});

vi.mock("../lib/secrets", () => ({
  getToolSecret: async (name: string) => secretsState[name],
}));

vi.mock("../lib/wiz-auth", () => ({
  getWizAccessToken: getWizAccessTokenMock,
  WIZ_ALLOWED_HOST_RE: /^[a-z0-9][a-z0-9.-]*\.wiz\.io$/i,
}));

beforeEach(() => {
  resolveAuthMock.mockReset();
  fetchMock.mockReset();
  getWizAccessTokenMock.mockReset();
  for (const key of Object.keys(secretsState)) delete secretsState[key];
  resolveAuthMock.mockResolvedValue({
    ownerId: "admin-id",
    name: "admin@example.com",
    role: "admin",
    provider: "entra-id",
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function callProbe(): Promise<Response> {
  const { POST } = await import("../app/api/integrations/[slug]/test/route");
  const req = new Request("http://localhost/api/integrations/wiz/test", {
    method: "POST",
  });
  const params = Promise.resolve({ slug: "wiz" });
  return POST(req as never, { params } as never);
}

function setOAuthCreds(): void {
  secretsState.WIZ_CLIENT_ID = "test-client";
  secretsState.WIZ_CLIENT_SECRET = "test-secret";
  secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
  secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
}

// ── Authorization ────────────────────────────────────────────

describe("Wiz integration probe — authorization", () => {
  it("returns 403 for reader role", async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: "reader-id",
      name: "reader@example.com",
      role: "reader",
      provider: "entra-id",
    });
    const res = await callProbe();
    expect(res.status).toBe(403);
  });
});

// ── Missing-credential failure modes ─────────────────────────

describe("Wiz integration probe — credentials", () => {
  it("fails closed when no Wiz credentials are configured at all", async () => {
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Missing Wiz credentials/);
  });

  it("fails closed when only WIZ_CLIENT_ID is set (incomplete OAuth)", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Missing Wiz credentials/);
  });

  it("fails closed when only WIZ_CLIENT_SECRET is set (incomplete OAuth)", async () => {
    secretsState.WIZ_CLIENT_SECRET = "s";
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Missing Wiz credentials/);
  });
});

// ── OAuth happy path ─────────────────────────────────────────

describe("Wiz integration probe — OAuth happy path", () => {
  it("mints a bearer via getWizAccessToken and OPTIONS the MCP URL with it", async () => {
    setOAuthCreds();
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(getWizAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://test.wiz.io/mcp");
    expect((init as RequestInit).method).toBe("OPTIONS");
    expect((init as RequestInit).redirect).toBe("error");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth-bearer-T1");
  });

  it("succeeds on a 204 from the MCP server", async () => {
    setOAuthCreds();
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("defaults WIZ_MCP_URL to https://mcp.app.wiz.io when unset", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    // WIZ_MCP_URL intentionally unset.
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await callProbe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    // The probe reconstructs the URL from validated parts
    // (parsed.hostname + parsed.pathname + parsed.search) before
    // the fetch, which normalises an empty pathname to "/".
    // Semantically equivalent — HTTP requests always send a path.
    expect(url).toBe("https://mcp.app.wiz.io/");
  });
});

// ── OAuth-failure path ───────────────────────────────────────

describe("Wiz integration probe — OAuth failure surfacing", () => {
  it("surfaces a distinct 'authentication failed' message when getWizAccessToken throws", async () => {
    setOAuthCreds();
    getWizAccessTokenMock.mockRejectedValue(
      new Error("Wiz OAuth token request failed (HTTP 401): invalid_client"),
    );

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Wiz authentication failed/);
    expect(body.error).toMatch(/HTTP 401/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a host-allowlist rejection from getWizAccessToken", async () => {
    setOAuthCreds();
    getWizAccessTokenMock.mockRejectedValue(
      new Error("WIZ_AUTH_URL hostname 'attacker.example.com' is not in the allowlist — Wiz hosts must end in .wiz.io"),
    );

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Wiz authentication failed/);
    expect(body.error).toMatch(/allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── MCP-side failure paths (after a successful OAuth exchange) ──

describe("Wiz integration probe — MCP failure surfacing", () => {
  it("returns a distinct bearer-rejected message on MCP 401", async () => {
    setOAuthCreds();
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Wiz MCP server rejected the bearer token/);
    expect(body.error).toMatch(/HTTP 401/);
  });

  it("returns a server-error message on 5xx", async () => {
    setOAuthCreds();
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");
    fetchMock.mockResolvedValue(new Response("Server Error", { status: 503 }));

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/HTTP 503/);
  });

  it("rejects a non-https MCP URL up front (no token egress on plaintext)", async () => {
    setOAuthCreds();
    secretsState.WIZ_MCP_URL = "http://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/https/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an MCP URL whose host is not in the allowlist", async () => {
    setOAuthCreds();
    secretsState.WIZ_MCP_URL = "https://attacker.example.com/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not in the allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Legacy backward-compat path ──────────────────────────────

describe("Wiz integration probe — legacy WIZ_MCP_TOKEN fallback", () => {
  it("uses WIZ_MCP_TOKEN as the bearer when no OAuth creds are configured", async () => {
    secretsState.WIZ_MCP_TOKEN = "legacy-static-bearer";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(getWizAccessTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer legacy-static-bearer");
  });

  it("surfaces an MCP 401 with the dual-path hint message", async () => {
    secretsState.WIZ_MCP_TOKEN = "legacy-static-bearer";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Wiz MCP server rejected the bearer token/);
    expect(body.error).toMatch(/WIZ_MCP_TOKEN/);
  });
});
