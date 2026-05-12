import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the route's dependencies. The probe lives at
// web/app/api/integrations/[slug]/test/route.ts and we test only
// the `wiz` branch here. Auth and integration-registry mocks
// mirror the patterns used by web/test/triage-mappings-route.test.ts.

const { resolveAuthMock, fetchMock, secretsState } = vi.hoisted(() => ({
  resolveAuthMock: vi.fn(),
  fetchMock: vi.fn(),
  secretsState: {} as Record<string, string | undefined>,
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

beforeEach(() => {
  resolveAuthMock.mockReset();
  fetchMock.mockReset();
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

describe("Wiz integration probe", () => {
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

  it("fails closed when WIZ_MCP_URL is missing", async () => {
    secretsState.WIZ_MCP_TOKEN = "tok";
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/WIZ_MCP_URL/);
  });

  it("fails closed when WIZ_MCP_TOKEN is missing", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/WIZ_MCP_TOKEN/);
  });

  it("rejects a non-https URL up front (no token egress on plaintext)", async () => {
    secretsState.WIZ_MCP_URL = "http://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "tok";
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/https/i);
    // Critically: the fetch must NOT have been issued
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("succeeds on a 200 from the MCP server", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "tok";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("succeeds on a 204 from the MCP server (some servers return No Content on OPTIONS)", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "tok";
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns a distinct auth-failure message on 401", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "tok";
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Wiz authentication failed/);
    expect(body.error).toMatch(/WIZ_MCP_TOKEN/);
  });

  it("returns a server-error message on 5xx", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "tok";
    fetchMock.mockResolvedValue(new Response("Server Error", { status: 503 }));
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/HTTP 503/);
  });

  it("sends Authorization: Bearer <token> with redirect: error", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "secret-token-value";
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await callProbe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://wiz.example.com/mcp");
    expect((init as RequestInit).method).toBe("OPTIONS");
    expect((init as RequestInit).redirect).toBe("error");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token-value");
  });
});
