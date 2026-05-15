import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveAuthMock, getInfosecAccessTokenMock, mcpClientMock } = vi.hoisted(() => ({
  resolveAuthMock: vi.fn(),
  getInfosecAccessTokenMock: vi.fn<() => Promise<string>>(),
  mcpClientMock: {
    ensureSession: vi.fn(),
    callTool: vi.fn(),
    reset: vi.fn(),
  },
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

vi.mock("../lib/infosec-auth", () => ({
  getInfosecAccessToken: getInfosecAccessTokenMock,
}));

vi.mock("../lib/mcp-client", () => ({
  getMcpClient: vi.fn(() => mcpClientMock),
  INFOSEC_LOGIC_APP_URL_ALLOWLIST: new Set<string>([
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp",
  ]),
}));

const envState = {
  INFOSEC_LOGIC_APP_MCP_URL:
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp" as string | undefined,
};
vi.mock("../lib/config", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "INFOSEC_LOGIC_APP_MCP_URL") return envState.INFOSEC_LOGIC_APP_MCP_URL;
      return undefined;
    },
  }),
}));

beforeEach(() => {
  resolveAuthMock.mockReset();
  getInfosecAccessTokenMock.mockReset();
  mcpClientMock.ensureSession.mockReset();
  mcpClientMock.callTool.mockReset();
  mcpClientMock.reset.mockReset();
  envState.INFOSEC_LOGIC_APP_MCP_URL =
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp";
  resolveAuthMock.mockResolvedValue({
    ownerId: "admin-id",
    name: "admin@example.com",
    role: "admin",
    provider: "entra-id",
  });
});

afterEach(() => {
  vi.resetModules();
});

async function callProbe(): Promise<Response> {
  const { POST } = await import("../app/api/integrations/[slug]/test/route");
  const req = new Request("http://localhost/api/integrations/infosec-incident-response/test", {
    method: "POST",
  });
  const params = Promise.resolve({ slug: "infosec-incident-response" });
  return POST(req as never, { params } as never);
}

describe("Infosec probe — RBAC", () => {
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

  it("returns 403 for triage role", async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: "triage-id",
      name: "triage@example.com",
      role: "triage",
      provider: "entra-id",
    });
    const res = await callProbe();
    expect(res.status).toBe(403);
  });
});

describe("Infosec probe — happy path", () => {
  it("admin runs token mint + MCP handshake and returns success", async () => {
    getInfosecAccessTokenMock.mockResolvedValue("test-bearer");
    mcpClientMock.ensureSession.mockResolvedValue({ sessionId: "sess-1" });

    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(getInfosecAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(mcpClientMock.reset).toHaveBeenCalledTimes(1);
    expect(mcpClientMock.ensureSession).toHaveBeenCalledTimes(1);
  });
});

describe("Infosec probe — failure surfacing", () => {
  it("Entra failure surfaces as 'Infosec authentication failed'", async () => {
    getInfosecAccessTokenMock.mockRejectedValue(
      new Error("Entra token request failed for api://x (HTTP 401): invalid_client"),
    );
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Infosec authentication failed/);
    expect(body.error).toMatch(/HTTP 401|invalid_client/);
    expect(mcpClientMock.ensureSession).not.toHaveBeenCalled();
  });

  it("missing INFOSEC_LOGIC_APP_MCP_URL surfaces a precise error", async () => {
    getInfosecAccessTokenMock.mockResolvedValue("test-bearer");
    envState.INFOSEC_LOGIC_APP_MCP_URL = undefined;
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Missing INFOSEC_LOGIC_APP_MCP_URL/);
    expect(mcpClientMock.ensureSession).not.toHaveBeenCalled();
  });

  it("URL not in allowlist surfaces a precise error", async () => {
    getInfosecAccessTokenMock.mockResolvedValue("test-bearer");
    envState.INFOSEC_LOGIC_APP_MCP_URL = "https://attacker.example.com/mcp";
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not in the probe allowlist/);
    expect(mcpClientMock.ensureSession).not.toHaveBeenCalled();
  });

  it("MCP handshake failure surfaces as 'Logic App handshake failed'", async () => {
    getInfosecAccessTokenMock.mockResolvedValue("test-bearer");
    mcpClientMock.ensureSession.mockRejectedValue(
      new Error("MCP initialize failed (HTTP 503): upstream is broken"),
    );
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Infosec Logic App handshake failed/);
    expect(body.error).toMatch(/HTTP 503/);
  });

  it("missing AGENT_CLIENT_ID surfaces through the Entra-failure branch with the specific name", async () => {
    getInfosecAccessTokenMock.mockRejectedValue(
      new Error("Missing AGENT_CLIENT_ID — required to mint a token for the Information Security Incident Response Logic App. Configure via /integrations or as an env var."),
    );
    const res = await callProbe();
    const body = await res.json();
    expect(body.error).toMatch(/Missing AGENT_CLIENT_ID/);
  });
});
