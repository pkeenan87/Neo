import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wiz integration probe is currently DISABLED — see the comment
// block in web/lib/mcp-servers.ts above the empty REGISTRY for
// the rationale. These tests pin the disabled contract so a
// future re-enable PR has to touch this file too.

const { resolveAuthMock, fetchMock } = vi.hoisted(() => ({
  resolveAuthMock: vi.fn(),
  fetchMock: vi.fn(),
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
  getToolSecret: async () => undefined,
}));

beforeEach(() => {
  resolveAuthMock.mockReset();
  fetchMock.mockReset();
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

describe("Wiz integration probe (currently disabled)", () => {
  it("returns 403 for reader role (RBAC check runs before the disabled branch)", async () => {
    resolveAuthMock.mockResolvedValue({
      ownerId: "reader-id",
      name: "reader@example.com",
      role: "reader",
      provider: "entra-id",
    });
    const res = await callProbe();
    expect(res.status).toBe(403);
  });

  it("returns a clear 'currently unavailable' error to admin, without contacting any Wiz endpoint", async () => {
    const res = await callProbe();
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/currently unavailable/);
    expect(body.error).toMatch(/Wiz-Client-\* headers|MCP connector/);
    // Disabled state never touches the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
