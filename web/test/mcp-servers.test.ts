import { describe, expect, it, beforeEach, vi } from "vitest";

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
// but we don't want test output noise. Hoisted spies so individual
// tests can assert specific log calls (N2 + deprecation warn).
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

// Mock wiz-auth — the registry calls getWizAccessToken on the
// preferred path. We return a stub bearer (or throw) per test.
// WIZ_ALLOWED_HOST_RE re-exports through mcp-servers, so the live
// regex still gates the MCP URL check.
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
  // Default: not in mock mode (live-Cosmos / Key Vault path).
  envState.MOCK_MODE = false;
  warnSpy.mockClear();
  errorSpy.mockClear();
  infoSpy.mockClear();
  debugSpy.mockClear();
  getWizAccessTokenMock.mockReset();
});

// ── getMcpServers — service-account OAuth path ───────────────

describe("getMcpServers (service-account OAuth)", () => {
  it("returns empty when no creds are configured (no OAuth, no legacy)", async () => {
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns empty when only WIZ_CLIENT_ID is set", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns the Wiz server when service-account creds resolve and role is admin", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const servers = await getMcpServers("admin");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      type: "url",
      name: "wiz",
      url: "https://test.wiz.io/mcp",
      authorization_token: "oauth-bearer-T1",
    });
    expect(getWizAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it("defaults WIZ_MCP_URL to https://mcp.app.wiz.io when unset", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const servers = await getMcpServers("admin");
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe("https://mcp.app.wiz.io");
  });

  it("omits tool_configuration for admin (allow-all)", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const servers = await getMcpServers("admin");
    expect(servers[0].tool_configuration).toBeUndefined();
  });

  it("includes literal expanded allowed_tools for reader role", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const servers = await getMcpServers("reader");
    expect(servers).toHaveLength(1);
    const allowed = servers[0].tool_configuration?.allowed_tools;
    expect(allowed).toBeDefined();
    expect(allowed).not.toContain("wiz_get_defend_threat");
    expect(allowed).not.toContain("wiz_get_blast_radius");
    expect(allowed).toContain("wiz_get_issues");
    expect(allowed).toContain("wiz_get_compliance");
  });

  it("triage role gets the same scoping as reader (Logic Apps inherit)", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const readerServers = await getMcpServers("reader");
    const triageServers = await getMcpServers("triage");
    expect(triageServers[0].tool_configuration?.allowed_tools).toEqual(
      readerServers[0].tool_configuration?.allowed_tools,
    );
  });

  it("skips Wiz (returns empty) when getWizAccessToken throws — fail-open", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockRejectedValue(new Error("token endpoint down"));

    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Wiz OAuth token fetch failed"),
      expect.any(String),
      expect.objectContaining({ mcpServer: "wiz", errorMessage: "token endpoint down" }),
    );
  });
});

// ── Backward-compat: legacy WIZ_MCP_TOKEN path ───────────────

describe("getMcpServers (legacy WIZ_MCP_TOKEN fallback)", () => {
  it("uses the legacy bearer when OAuth creds are absent and emits a deprecation warn", async () => {
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    secretsState.WIZ_MCP_TOKEN = "legacy-static-bearer";

    const servers = await getMcpServers("admin");
    expect(servers).toHaveLength(1);
    expect(servers[0].authorization_token).toBe("legacy-static-bearer");
    expect(getWizAccessTokenMock).not.toHaveBeenCalled();

    const deprecationCall = warnSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("deprecated WIZ_MCP_TOKEN"),
    );
    expect(deprecationCall).toBeDefined();
  });

  it("prefers OAuth over the legacy token when both are configured", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    secretsState.WIZ_MCP_TOKEN = "legacy-static-bearer";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const servers = await getMcpServers("admin");
    expect(servers[0].authorization_token).toBe("oauth-bearer-T1");
    expect(getWizAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});

// ── Mock-mode behaviour ──────────────────────────────────────

describe("getMcpServers — mock mode disables Wiz", () => {
  it("returns empty in mock mode even when service-account creds are set", async () => {
    envState.MOCK_MODE = true;
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
    expect(getWizAccessTokenMock).not.toHaveBeenCalled();
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

  // M5: admin allow-all is still bounded by the catalogue.
  it("denies admin invocation of a tool not in the catalogue (M5)", () => {
    expect(enforceMcpToolAccess("admin", "wiz", "wiz_delete_everything")).toBe(false);
  });

  it("permits admin invocation of every catalogued tool (M5)", () => {
    for (const tool of WIZ_TOOL_CATALOGUE) {
      expect(enforceMcpToolAccess("admin", "wiz", tool)).toBe(true);
    }
  });
});

// ── B3: runtime HTTPS enforcement on the MCP URL ─────────────

describe("getMcpServers — HTTPS enforcement (B3)", () => {
  beforeEach(() => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");
  });

  it("returns empty when WIZ_MCP_URL uses http://", async () => {
    secretsState.WIZ_MCP_URL = "http://test.wiz.io/mcp";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns empty when WIZ_MCP_URL is malformed", async () => {
    secretsState.WIZ_MCP_URL = "not a valid url at all";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });

  it("returns the server when WIZ_MCP_URL uses https://", async () => {
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    const servers = await getMcpServers("admin");
    expect(servers).toHaveLength(1);
  });

  it("rejects WIZ_MCP_URL whose host is not in the allowlist", async () => {
    secretsState.WIZ_MCP_URL = "https://attacker.example.com/mcp";
    const servers = await getMcpServers("admin");
    expect(servers).toEqual([]);
  });
});

// ── N2: empty pattern-expansion produces a warn ──────────────

describe("getMcpServers — empty pattern expansion warns (N2)", () => {
  it("does not warn when reader's catalogued patterns expand cleanly", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    secretsState.WIZ_MCP_URL = "https://test.wiz.io/mcp";
    getWizAccessTokenMock.mockResolvedValue("oauth-bearer-T1");

    await getMcpServers("reader");
    const n2Calls = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("expanded to zero catalogue tools"),
    );
    expect(n2Calls).toHaveLength(0);
  });
});
