import { describe, expect, it, beforeEach, vi } from "vitest";

// Wiz MCP integration is currently DISABLED — see the comment
// block above the empty REGISTRY in web/lib/mcp-servers.ts for
// the full rationale. These tests pin the disabled-state
// contract so a future re-enable PR has to touch this file too,
// signalling the change.
//
// Mocks for secrets / config / logger / wiz-auth are kept (and
// not exercised) because reintroducing them when the integration
// re-enables is the harder lift than the assertions themselves.

const secretsState: Record<string, string | undefined> = {};
vi.mock("../lib/secrets", () => ({
  getToolSecret: async (name: string) => secretsState[name],
}));

const envState = { MOCK_MODE: false as boolean };
vi.mock("../lib/config", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "MOCK_MODE") return envState.MOCK_MODE;
      return undefined;
    },
  }),
}));

const { warnSpy, errorSpy, infoSpy, debugSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  debugSpy: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    debug: debugSpy,
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hashed-${s}`,
}));

const { getWizAccessTokenMock } = vi.hoisted(() => ({
  getWizAccessTokenMock: vi.fn<() => Promise<string>>(),
}));
vi.mock("../lib/wiz-auth", () => ({
  getWizAccessToken: getWizAccessTokenMock,
  WIZ_ALLOWED_HOST_RE: /^[a-z0-9][a-z0-9.-]*\.wiz\.io$/i,
}));

import {
  getMcpServers,
  enforceMcpToolAccess,
  WIZ_TOOL_CATALOGUE,
} from "../lib/mcp-servers";

beforeEach(() => {
  for (const key of Object.keys(secretsState)) delete secretsState[key];
  envState.MOCK_MODE = false;
  warnSpy.mockClear();
  errorSpy.mockClear();
  infoSpy.mockClear();
  debugSpy.mockClear();
  getWizAccessTokenMock.mockReset();
});

// ── getMcpServers — disabled-state contract ──────────────────

describe("getMcpServers (Wiz MCP integration disabled)", () => {
  it("returns an empty array for every role, regardless of configured credentials", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_API_URL = "https://api.us68.app.wiz.io/graphql";
    secretsState.WIZ_MCP_URL = "https://mcp.app.wiz.io";
    secretsState.WIZ_MCP_TOKEN = "legacy-static-bearer";

    expect(await getMcpServers("admin")).toEqual([]);
    expect(await getMcpServers("reader")).toEqual([]);
    expect(await getMcpServers("triage")).toEqual([]);
  });

  it("never calls getWizAccessToken (registry is empty so the OAuth path is dead code)", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";

    await getMcpServers("admin");
    expect(getWizAccessTokenMock).not.toHaveBeenCalled();
  });

  it("returns an empty array in mock mode too", async () => {
    envState.MOCK_MODE = true;
    expect(await getMcpServers("admin")).toEqual([]);
  });
});

// ── enforceMcpToolAccess — empty registry returns false ──────

describe("enforceMcpToolAccess (registry empty)", () => {
  it("returns false for the wiz server (no registry entry)", () => {
    expect(enforceMcpToolAccess("admin", "wiz", "wiz_get_issues")).toBe(false);
  });

  it("returns false for any other server name", () => {
    expect(enforceMcpToolAccess("admin", "unknown", "anything")).toBe(false);
  });

  it("returns false for every role and every catalogued tool while disabled", () => {
    for (const tool of WIZ_TOOL_CATALOGUE) {
      expect(enforceMcpToolAccess("admin", "wiz", tool)).toBe(false);
      expect(enforceMcpToolAccess("reader", "wiz", tool)).toBe(false);
      expect(enforceMcpToolAccess("triage", "wiz", tool)).toBe(false);
    }
  });
});

// ── WIZ_TOOL_CATALOGUE export ────────────────────────────────

describe("WIZ_TOOL_CATALOGUE", () => {
  it("is still exported for the Settings UI capability listing even while the integration is disabled", () => {
    // The integration registry shows operators which Wiz tools
    // the integration WILL expose once re-enabled. Removing the
    // catalogue export would break that listing.
    expect(WIZ_TOOL_CATALOGUE).toContain("wiz_get_issues");
    expect(WIZ_TOOL_CATALOGUE).toContain("wiz_search_security_graph");
    expect(WIZ_TOOL_CATALOGUE.length).toBeGreaterThan(0);
  });
});
