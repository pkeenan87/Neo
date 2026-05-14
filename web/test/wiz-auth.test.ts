import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the secrets-store mock and the logger spies so vi.mock can
// reference them before the wiz-auth import below.
const { secretsState, warnSpy, errorSpy, infoSpy, debugSpy } = vi.hoisted(() => ({
  secretsState: {} as Record<string, string | undefined>,
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock("../lib/secrets", () => ({
  getToolSecret: async (name: string) => secretsState[name],
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    debug: debugSpy,
    emitEvent: vi.fn(),
  },
}));

import {
  getWizAccessToken,
  clearWizTokenCache,
  getWizDatacenter,
  WIZ_ALLOWED_HOST_RE,
} from "../lib/wiz-auth";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = global.fetch;

beforeEach(() => {
  for (const key of Object.keys(secretsState)) delete secretsState[key];
  clearWizTokenCache();
  warnSpy.mockClear();
  errorSpy.mockClear();
  infoSpy.mockClear();
  debugSpy.mockClear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

// ── getWizAccessToken ────────────────────────────────────────

describe("getWizAccessToken", () => {
  beforeEach(() => {
    secretsState.WIZ_CLIENT_ID = "test-client";
    secretsState.WIZ_CLIENT_SECRET = "test-secret";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
  });

  it("POSTs form-urlencoded body to the auth URL with the Cognito audience and returns the access token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );

    const token = await getWizAccessToken();
    expect(token).toBe("T1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auth.app.wiz.io/oauth/token");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // Body is URLSearchParams; iterate to assert the four expected
    // key/value pairs without depending on encoded-string ordering.
    const params = init?.body as URLSearchParams;
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("test-client");
    expect(params.get("client_secret")).toBe("test-secret");
    // auth.app.wiz.io (Cognito) → wiz-api
    expect(params.get("audience")).toBe("wiz-api");
  });

  it("uses 'beyond-api' audience when the auth URL is the Auth0 endpoint", async () => {
    secretsState.WIZ_AUTH_URL = "https://auth.wiz.io/oauth/token";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );

    await getWizAccessToken();
    const [, init] = fetchMock.mock.calls[0];
    const params = init?.body as URLSearchParams;
    // auth.wiz.io (Auth0) → beyond-api
    expect(params.get("audience")).toBe("beyond-api");
  });

  it("caches the token across calls until near-expiry", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );

    const first = await getWizAccessToken();
    const second = await getWizAccessToken();
    expect(first).toBe("T1");
    expect(second).toBe("T1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the cached token has expired", async () => {
    // expires_in:60 falls inside the 5-min safety buffer, so the
    // cache entry is born expired and the next call re-fetches.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 60 }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T2", token_type: "Bearer", expires_in: 3600 }),
    );

    const first = await getWizAccessToken();
    expect(first).toBe("T1");
    const second = await getWizAccessToken();
    expect(second).toBe("T2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rotating client_secret produces a new cache key (different token returned)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T2", token_type: "Bearer", expires_in: 3600 }),
    );

    expect(await getWizAccessToken()).toBe("T1");
    secretsState.WIZ_CLIENT_SECRET = "rotated-secret";
    expect(await getWizAccessToken()).toBe("T2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when WIZ_CLIENT_ID is missing", async () => {
    delete secretsState.WIZ_CLIENT_ID;
    await expect(getWizAccessToken()).rejects.toThrow(/Missing Wiz service account configuration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when WIZ_CLIENT_SECRET is missing", async () => {
    delete secretsState.WIZ_CLIENT_SECRET;
    await expect(getWizAccessToken()).rejects.toThrow(/Missing Wiz service account configuration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when WIZ_AUTH_URL is missing", async () => {
    delete secretsState.WIZ_AUTH_URL;
    await expect(getWizAccessToken()).rejects.toThrow(/Missing Wiz service account configuration/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when WIZ_AUTH_URL is non-https (not in the literal allowlist)", async () => {
    secretsState.WIZ_AUTH_URL = "http://auth.app.wiz.io/oauth/token";
    await expect(getWizAccessToken()).rejects.toThrow(/not in the Wiz auth-URL allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when WIZ_AUTH_URL hostname is not in the literal allowlist", async () => {
    secretsState.WIZ_AUTH_URL = "https://attacker.example.com/oauth/token";
    await expect(getWizAccessToken()).rejects.toThrow(/not in the Wiz auth-URL allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the alternative documented Wiz auth URL (auth.wiz.io)", async () => {
    secretsState.WIZ_AUTH_URL = "https://auth.wiz.io/oauth/token";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );
    const token = await getWizAccessToken();
    expect(token).toBe("T1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auth.wiz.io/oauth/token");
  });

  it("trims whitespace before checking the auth URL allowlist", async () => {
    secretsState.WIZ_AUTH_URL = "  https://auth.app.wiz.io/oauth/token\n";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );
    const token = await getWizAccessToken();
    expect(token).toBe("T1");
  });

  it("surfaces a 401 from the token endpoint with the body included", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(JSON.stringify({ error: "invalid_client" }), 401),
    );
    await expect(getWizAccessToken()).rejects.toThrow(/HTTP 401.*invalid_client/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("token endpoint rejected credentials"),
      expect.any(String),
      expect.objectContaining({ mcpServer: "wiz", statusCode: 401 }),
    );
  });

  it("surfaces a 5xx from the token endpoint", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("upstream is broken", 503));
    await expect(getWizAccessToken()).rejects.toThrow(/HTTP 503/);
  });

  it("surfaces a fetch transport error with the helper's wrapper message", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(getWizAccessToken()).rejects.toThrow(/Wiz OAuth token request failed: network down/);
  });

  it("throws when the response is missing access_token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token_type: "Bearer", expires_in: 3600 }));
    await expect(getWizAccessToken()).rejects.toThrow(/missing access_token/);
  });

  it("throws when expires_in is not a number", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer" }),
    );
    await expect(getWizAccessToken()).rejects.toThrow(/missing access_token or expires_in/);
  });
});

// ── clearWizTokenCache ───────────────────────────────────────

describe("clearWizTokenCache", () => {
  it("forces a fresh fetch on the next call", async () => {
    secretsState.WIZ_CLIENT_ID = "c";
    secretsState.WIZ_CLIENT_SECRET = "s";
    secretsState.WIZ_AUTH_URL = "https://auth.app.wiz.io/oauth/token";
    // Use `mockResolvedValueOnce` twice so each call gets a fresh
    // Response — Response bodies can only be consumed once.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T1", token_type: "Bearer", expires_in: 3600 }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "T2", token_type: "Bearer", expires_in: 3600 }),
    );
    expect(await getWizAccessToken()).toBe("T1");
    clearWizTokenCache();
    expect(await getWizAccessToken()).toBe("T2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── getWizDatacenter ─────────────────────────────────────────

describe("getWizDatacenter", () => {
  it("parses us68 from api.us68.app.wiz.io/graphql", async () => {
    secretsState.WIZ_API_URL = "https://api.us68.app.wiz.io/graphql";
    expect(await getWizDatacenter()).toBe("us68");
  });

  it("lower-cases mixed-case data centers", async () => {
    secretsState.WIZ_API_URL = "https://api.US68.app.wiz.io/graphql";
    expect(await getWizDatacenter()).toBe("us68");
  });

  it("returns undefined when WIZ_API_URL is unset", async () => {
    expect(await getWizDatacenter()).toBeUndefined();
  });

  it("returns undefined when the URL is unparseable", async () => {
    secretsState.WIZ_API_URL = "not a url";
    expect(await getWizDatacenter()).toBeUndefined();
  });

  it("returns undefined when hostname does not fit api.<dc>.app.wiz.io", async () => {
    secretsState.WIZ_API_URL = "https://api.wiz.io/graphql";
    expect(await getWizDatacenter()).toBeUndefined();
  });
});

// ── WIZ_ALLOWED_HOST_RE ──────────────────────────────────────

describe("WIZ_ALLOWED_HOST_RE", () => {
  it.each([
    ["app.wiz.io", true],
    ["mcp.app.wiz.io", true],
    ["us68.app.wiz.io", true],
    ["api.us68.app.wiz.io", true],
    ["auth.app.wiz.io", true],
    ["auth.wiz.io", true],
    ["wizattacker.com", false],
    ["wiz.io.evil.com", false],
    ["169.254.169.254", false],
    ["localhost", false],
    [".wiz.io", false],
  ])("regex matches '%s' → %s", (host, expected) => {
    expect(WIZ_ALLOWED_HOST_RE.test(host)).toBe(expected);
  });
});
