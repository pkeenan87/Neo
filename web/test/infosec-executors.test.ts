import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the MCP client so the executors don't actually hit the
// network. Also mock infosec-auth to avoid the Entra token mint.
const { mcpClientMock } = vi.hoisted(() => ({
  mcpClientMock: {
    callTool: vi.fn(),
    ensureSession: vi.fn(),
    reset: vi.fn(),
  },
}));
vi.mock("../lib/mcp-client", () => ({
  getMcpClient: vi.fn(() => mcpClientMock),
  INFOSEC_LOGIC_APP_URL_ALLOWLIST: new Set<string>([
    "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp",
  ]),
}));
vi.mock("../lib/infosec-auth", () => ({
  getInfosecAccessToken: vi.fn(async () => "stub-token"),
}));

// Mock secrets — the executor now reads INFOSEC_LOGIC_APP_MCP_URL
// from Key Vault first, falling back to env. Tests exercise the env
// path, so return undefined from getToolSecret for everything.
vi.mock("../lib/secrets", () => ({
  getToolSecret: vi.fn(async () => undefined),
}));

// Mock config.env so we can flip MOCK_MODE and INFOSEC_LOGIC_APP_MCP_URL per test.
const envState = {
  MOCK_MODE: false as boolean,
  INFOSEC_LOGIC_APP_MCP_URL: "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp" as string | undefined,
};
vi.mock("../lib/config", () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "MOCK_MODE") return envState.MOCK_MODE;
      if (prop === "INFOSEC_LOGIC_APP_MCP_URL") return envState.INFOSEC_LOGIC_APP_MCP_URL;
      return undefined;
    },
  }),
  REMEDIATE_MAX_EXPLICIT_MESSAGES: 20,
}));

// Mock the log context so we control responder injection per-test.
const logContextState = { userName: "admin@example.com" as string | undefined };
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hashed-${s}`,
  getLogContext: () => (logContextState.userName ? { userName: logContextState.userName } : undefined),
}));

import { executeTool } from "../lib/executors";

beforeEach(() => {
  mcpClientMock.callTool.mockReset();
  mcpClientMock.ensureSession.mockReset();
  mcpClientMock.reset.mockReset();
  envState.MOCK_MODE = false;
  envState.INFOSEC_LOGIC_APP_MCP_URL = "https://logic-infosecautomation-prod-001-b0b2eje4fehphtf2.eastus2-01.azurewebsites.net/api/mcpservers/InfosecIncidentResponse/mcp";
  logContextState.userName = "admin@example.com";
  mcpClientMock.callTool.mockResolvedValue({
    content: [{ type: "text", text: "ok" }],
    isError: false,
    correlationHeaders: {
      apiManagementRequestId: "ar-1",
      apiManagementMiddlewareRequestId: "mw-1",
      workflowRunId: "wf-1",
      mcpSessionId: "sess-1",
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Mock-mode short-circuit ──────────────────────────────────

describe("Infosec executors — mock mode", () => {
  it("block_ipaddress returns a synthetic fixture without calling the MCP client", async () => {
    envState.MOCK_MODE = true;
    const result = (await executeTool("block_ipaddress", { ioc: "1.2.3.4", notes: "n" })) as Record<string, unknown>;
    expect(result.mocked).toBe(true);
    expect(result.tool).toBe("block-ipaddress");
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("request_sslbypass mock-mode also short-circuits", async () => {
    envState.MOCK_MODE = true;
    const result = (await executeTool("request_sslbypass", {
      reportedDomain: "ok.example.com",
    })) as Record<string, unknown>;
    expect(result.mocked).toBe(true);
    expect(result.tool).toBe("request-sslbypass");
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });
});

// ── Live-mode dispatch ───────────────────────────────────────

describe("Infosec executors — live dispatch", () => {
  it("block_ipaddress forwards { responder, ioc, notes } to the kebab-case Logic App tool", async () => {
    await executeTool("block_ipaddress", { ioc: "203.0.113.7", notes: "C2 IOC" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("block-ipaddress", {
      responder: "admin@example.com",
      ioc: "203.0.113.7",
      notes: "C2 IOC",
    });
  });

  it("block_domain, block_email, block_globalprotect, block_hash all forward the same shape", async () => {
    await executeTool("block_domain", { ioc: "bad.example.com", notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("block-domain", expect.objectContaining({ responder: "admin@example.com", ioc: "bad.example.com" }));
    await executeTool("block_email", { ioc: "bad@example.com", notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("block-email", expect.objectContaining({ responder: "admin@example.com", ioc: "bad@example.com" }));
    await executeTool("block_globalprotect", { ioc: "user-id-1", notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("block-globalprotect", expect.objectContaining({ responder: "admin@example.com", ioc: "user-id-1" }));
    await executeTool("block_hash", { ioc: "d41d8cd98f00b204e9800998ecf8427e", notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("block-hash", expect.objectContaining({ responder: "admin@example.com" }));
  });

  it("request_sslbypass forwards { responder, submitDate, reportedDomain } and defaults submitDate to now", async () => {
    const before = new Date().toISOString();
    await executeTool("request_sslbypass", { reportedDomain: "third-party.example.com" });
    expect(mcpClientMock.callTool).toHaveBeenCalledTimes(1);
    const [name, payload] = mcpClientMock.callTool.mock.calls[0];
    expect(name).toBe("request-sslbypass");
    expect(payload).toMatchObject({
      responder: "admin@example.com",
      reportedDomain: "third-party.example.com",
    });
    // submitDate is auto-defaulted; assert it parses as a date and is >= test start.
    expect(typeof payload.submitDate).toBe("string");
    expect(new Date(payload.submitDate as string).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() - 1000);
  });

  it("request_sslbypass preserves a model-supplied submitDate when valid", async () => {
    await executeTool("request_sslbypass", {
      reportedDomain: "ok.example.com",
      submitDate: "2026-05-15T12:00:00Z",
    });
    const payload = mcpClientMock.callTool.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.submitDate).toBe("2026-05-15T12:00:00Z");
  });
});

// ── responder injection / refusal ────────────────────────────

describe("Infosec executors — responder injection", () => {
  it("ignores a model-supplied 'responder' field — it's server-populated", async () => {
    await executeTool("block_ipaddress", {
      ioc: "1.2.3.4",
      notes: "n",
      // The model schemes the responder to something untrusted; the
      // executor must overwrite it.
      responder: "ceo@target.example.com",
    });
    const payload = mcpClientMock.callTool.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.responder).toBe("admin@example.com");
  });

  it("refuses to fire when no authenticated user is in scope", async () => {
    logContextState.userName = undefined;
    await expect(executeTool("block_ipaddress", { ioc: "1.2.3.4", notes: "n" })).rejects.toThrow(
      /requires an authenticated user identity/,
    );
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });
});

// ── Input validation ────────────────────────────────────────

describe("Infosec executors — input validation", () => {
  it.each([
    ["block_ipaddress", { ioc: "not-an-ip", notes: "n" }, /not a valid IPv4 or IPv6/],
    ["block_ipaddress", { ioc: "999.999.999.999", notes: "n" }, /not a valid IPv4 or IPv6/],
    ["block_hash", { ioc: "abc123", notes: "n" }, /not a valid hex hash/],
    ["block_hash", { ioc: "g".repeat(32), notes: "n" }, /not a valid hex hash/],
    ["block_email", { ioc: "no-at-sign.example.com", notes: "n" }, /not a valid email/],
    ["block_email", { ioc: "double@@at.example.com", notes: "n" }, /not a valid email/],
    ["block_domain", { ioc: "https://has.protocol/x", notes: "n" }, /not a valid domain/],
    ["block_domain", { ioc: "no spaces.example.com", notes: "n" }, /not a valid domain/],
    ["request_sslbypass", { reportedDomain: "https://x" }, /not a valid domain/],
  ])("%s rejects invalid input %o", async (toolName, input, errorRe) => {
    await expect(executeTool(toolName, input as Record<string, unknown>)).rejects.toThrow(errorRe);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["block_ipaddress", { notes: "n" }, /missing required 'ioc'/],
    ["block_ipaddress", { ioc: "1.2.3.4" }, /missing required 'notes'/],
    ["request_sslbypass", {}, /missing required 'reportedDomain'/],
  ])("%s rejects missing required fields %o", async (toolName, input, errorRe) => {
    await expect(executeTool(toolName, input as Record<string, unknown>)).rejects.toThrow(errorRe);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("block_hash accepts valid MD5 (32 hex)", async () => {
    await executeTool("block_hash", { ioc: "d41d8cd98f00b204e9800998ecf8427e", notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalled();
  });

  it("block_hash accepts valid SHA1 (40 hex)", async () => {
    await executeTool("block_hash", { ioc: "a".repeat(40), notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalled();
  });

  it("block_hash accepts valid SHA256 (64 hex)", async () => {
    await executeTool("block_hash", { ioc: "b".repeat(64), notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalled();
  });

  it("request_sslbypass rejects an unparseable submitDate", async () => {
    await expect(
      executeTool("request_sslbypass", { reportedDomain: "ok.example.com", submitDate: "not-a-date" }),
    ).rejects.toThrow(/must be ISO-8601/);
  });

  // ── Ultra-review MEDIUM #5: IPv6 regex was too permissive ──
  // The old regex `/^[0-9a-fA-F:]+$/` accepted any hex string,
  // including MD5/SHA1/SHA256 hashes (no colons required). The fix
  // uses net.isIP() which implements RFC 4291 / 5952 exactly.
  it("block_ipaddress rejects an MD5 hash being passed as an IPv6 address", async () => {
    await expect(
      executeTool("block_ipaddress", { ioc: "d41d8cd98f00b204e9800998ecf8427e", notes: "n" }),
    ).rejects.toThrow(/not a valid IPv4 or IPv6/);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("block_ipaddress accepts a real IPv6 address", async () => {
    await executeTool("block_ipaddress", { ioc: "2001:db8::1", notes: "n" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("block-ipaddress", expect.objectContaining({ ioc: "2001:db8::1" }));
  });

  // ── Ultra-review MEDIUM #9 + LOW: control-char rejection ──
  // ASCII control chars (0x00–0x1F + 0x7F) would fragment audit
  // lines / SIEM consumers if forwarded. Reject before MCP dispatch.
  it("block_email rejects an ioc containing a NUL byte", async () => {
    await expect(
      executeTool("block_email", { ioc: "victim\x00@example.com", notes: "n" }),
    ).rejects.toThrow(/whitespace or control characters/);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("block_globalprotect rejects an ioc containing a control char", async () => {
    await expect(
      executeTool("block_globalprotect", { ioc: "user\x01id", notes: "n" }),
    ).rejects.toThrow(/control characters/);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  // ── Ultra-review MEDIUM #10: submitDate strict validation ──
  // V8 silently rolls '2026-02-30' forward to 2026-03-02. The fix
  // does a regex check first, then a round-trip parse-and-reformat
  // to detect that drift.
  it("request_sslbypass rejects '2026-02-30' (V8 would silently roll forward to March)", async () => {
    await expect(
      executeTool("request_sslbypass", { reportedDomain: "ok.example.com", submitDate: "2026-02-30" }),
    ).rejects.toThrow(/impossible calendar date/);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("request_sslbypass rejects a non-ISO-8601 shape like '2026/05/15'", async () => {
    await expect(
      executeTool("request_sslbypass", { reportedDomain: "ok.example.com", submitDate: "2026/05/15" }),
    ).rejects.toThrow(/must be ISO-8601/);
    expect(mcpClientMock.callTool).not.toHaveBeenCalled();
  });

  it("request_sslbypass accepts a date-only ISO submitDate", async () => {
    await executeTool("request_sslbypass", { reportedDomain: "ok.example.com", submitDate: "2026-05-15" });
    expect(mcpClientMock.callTool).toHaveBeenCalledWith("request-sslbypass", expect.objectContaining({ submitDate: "2026-05-15" }));
  });
});

// ── Result envelope shape ────────────────────────────────────

describe("Infosec executors — result envelope", () => {
  it("returns { status, content, correlationHeaders, responder, tool } from the MCP result", async () => {
    const result = (await executeTool("block_ipaddress", { ioc: "1.2.3.4", notes: "n" })) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "submitted",
      tool: "block-ipaddress",
      responder: "admin@example.com",
      correlationHeaders: { workflowRunId: "wf-1", mcpSessionId: "sess-1" },
    });
  });

  it("isError from the MCP result becomes status: 'error'", async () => {
    mcpClientMock.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "rejected by downstream" }],
      isError: true,
      correlationHeaders: {},
    });
    const result = (await executeTool("block_ipaddress", { ioc: "1.2.3.4", notes: "n" })) as Record<string, unknown>;
    expect(result.status).toBe("error");
  });
});

// ── Missing URL ──────────────────────────────────────────────

describe("Infosec executors — missing config", () => {
  it("throws a precise error when INFOSEC_LOGIC_APP_MCP_URL is unset", async () => {
    envState.INFOSEC_LOGIC_APP_MCP_URL = undefined;
    await expect(executeTool("block_ipaddress", { ioc: "1.2.3.4", notes: "n" })).rejects.toThrow(
      /INFOSEC_LOGIC_APP_MCP_URL is not configured/,
    );
  });
});
