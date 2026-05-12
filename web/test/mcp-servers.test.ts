import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock the secrets store so we can fully control what getMcpServers
// reads without touching Key Vault or env vars across tests.
const secretsState: Record<string, string | undefined> = {};
vi.mock("../lib/secrets", () => ({
  getToolSecret: async (name: string) => secretsState[name],
}));

// Mock config.env so we can flip MOCK_MODE per test. The real `env`
// is built at module-load time from process.env, so flipping
// process.env.MOCK_MODE in beforeEach has no effect — we need a
// mutable mock here for the tests that exercise the live-mode path
// to actually take it.
const envState = { MOCK_MODE: false as boolean };
vi.mock("../lib/config", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "MOCK_MODE") return envState.MOCK_MODE;
      return undefined;
    },
  }),
}));

// Quiet logger — getMcpServers warns on credential lookup errors,
// but we don't want test output noise.
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hashed-${s}`,
}));

import {
  getMcpServers,
  enforceMcpToolAccess,
  WIZ_TOOL_CATALOGUE,
} from "../lib/mcp-servers";

beforeEach(() => {
  for (const key of Object.keys(secretsState)) delete secretsState[key];
  // Default: not in mock mode (live-Cosmos / Key Vault path).
  envState.MOCK_MODE = false;
});

// ── getMcpServers ────────────────────────────────────────────

describe("getMcpServers", () => {
  it("returns empty when WIZ_MCP_URL is unset", async () => {
    secretsState.WIZ_MCP_TOKEN = "tok";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns empty when WIZ_MCP_TOKEN is unset", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns the Wiz server when both env vars resolve and role is admin", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "secret-token";
    const servers = await getMcpServers("admin");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      type: "url",
      name: "wiz",
      url: "https://wiz.example.com/mcp",
      authorization_token: "secret-token",
    });
  });

  it("omits tool_configuration for admin (allow-all)", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "secret-token";
    const servers = await getMcpServers("admin");
    expect(servers[0].tool_configuration).toBeUndefined();
  });

  it("includes literal expanded allowed_tools for reader role", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "secret-token";
    const servers = await getMcpServers("reader");
    expect(servers).toHaveLength(1);
    const allowed = servers[0].tool_configuration?.allowed_tools;
    expect(allowed).toBeDefined();
    // Reader gets the read-only subset — no defend, no blast-radius
    expect(allowed).not.toContain("wiz_get_defend_threat");
    expect(allowed).not.toContain("wiz_get_blast_radius");
    expect(allowed).toContain("wiz_get_issues");
    expect(allowed).toContain("wiz_get_compliance");
  });

  it("triage role gets the same scoping as reader (Logic Apps inherit)", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "secret-token";
    const readerServers = await getMcpServers("reader");
    const triageServers = await getMcpServers("triage");
    expect(triageServers[0].tool_configuration?.allowed_tools).toEqual(
      readerServers[0].tool_configuration?.allowed_tools,
    );
  });

  it("fails open (returns empty) when the secrets store throws", async () => {
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    // Force getToolSecret to throw on the token lookup
    vi.doMock("../lib/secrets", () => ({
      getToolSecret: async (name: string) => {
        if (name === "WIZ_MCP_TOKEN") throw new Error("Cosmos timeout");
        return secretsState[name];
      },
    }));
    vi.resetModules();
    const { getMcpServers: reload } = await import("../lib/mcp-servers");
    const servers = await reload("admin");
    expect(servers).toEqual([]);
  });
});

// ── Mock-mode behaviour ──────────────────────────────────────
// In the current iteration of the integration, mock mode disables
// Wiz unconditionally — the fixture short-circuit it would otherwise
// pair with is deferred to a follow-up. These tests pin the
// "no-Wiz-in-mock" guarantee so the deferral is testable and so a
// future contributor wiring fixtures back in updates these cases
// in lockstep with the registry change.

describe("getMcpServers — mock mode disables Wiz", () => {
  it("returns empty in mock mode even when both env vars are set", async () => {
    envState.MOCK_MODE = true;
    secretsState.WIZ_MCP_URL = "https://wiz.example.com/mcp";
    secretsState.WIZ_MCP_TOKEN = "tok";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns empty in mock mode when env vars are unset", async () => {
    envState.MOCK_MODE = true;
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });
});

// ── enforceMcpToolAccess ──────────────────────────────────────

describe("enforceMcpToolAccess", () => {
  it("returns false for an unknown server name", () => {
    expect(enforceMcpToolAccess("admin", "unknown", "wiz_get_issues")).toBe(false);
  });

  it("returns false when the role isn't allowed on the server", () => {
    // The Wiz server allows admin/reader/triage — there is no role
    // outside that union today, but make sure a not-listed role
    // can't slip through. Cast through unknown for the test.
    expect(
      enforceMcpToolAccess("nobody" as unknown as "admin", "wiz", "wiz_get_issues"),
    ).toBe(false);
  });

  it("returns true for admin on any catalogue tool (allow-all)", () => {
    for (const tool of WIZ_TOOL_CATALOGUE) {
      expect(enforceMcpToolAccess("admin", "wiz", tool)).toBe(true);
    }
  });

  it("returns false for reader on the defend / blast-radius write tools", () => {
    expect(enforceMcpToolAccess("reader", "wiz", "wiz_get_defend_threat")).toBe(false);
    expect(enforceMcpToolAccess("reader", "wiz", "wiz_get_blast_radius")).toBe(false);
  });

  it("returns true for reader on the read-only catalogue subset", () => {
    expect(enforceMcpToolAccess("reader", "wiz", "wiz_get_issues")).toBe(true);
    expect(enforceMcpToolAccess("reader", "wiz", "wiz_search_security_graph")).toBe(true);
  });

  it("triage role mirrors reader scoping", () => {
    expect(enforceMcpToolAccess("triage", "wiz", "wiz_get_issues")).toBe(true);
    expect(enforceMcpToolAccess("triage", "wiz", "wiz_get_defend_threat")).toBe(false);
  });
});
