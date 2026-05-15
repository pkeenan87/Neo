import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock secrets so we can flip cred state per test.
const secretsState: Record<string, string | undefined> = {};
vi.mock("../lib/secrets", () => ({
  getToolSecret: async (name: string) => secretsState[name],
}));

import {
  getInfosecAccessToken,
  clearInfosecTokenCache,
} from "../lib/infosec-auth";
import {
  getEntraTokenAs,
  clearEntraTokenCacheFor,
  clearAllEntraTokenCache,
  clearTokenCache,
} from "../lib/auth";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = global.fetch;

beforeEach(() => {
  for (const k of Object.keys(secretsState)) delete secretsState[k];
  clearTokenCache();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function entraTokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expiresIn }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── getEntraTokenAs ──────────────────────────────────────────

describe("getEntraTokenAs", () => {
  beforeEach(() => {
    secretsState.AZURE_TENANT_ID = "tenant-uuid";
  });

  it("POSTs form-urlencoded body to login.microsoftonline.com with the supplied creds", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T1"));

    const token = await getEntraTokenAs("client-id-A", "secret-A", "api://logic-app");
    expect(token).toBe("T1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("client-id-A");
    expect(body.get("client_secret")).toBe("secret-A");
    expect(body.get("scope")).toBe("api://logic-app/.default");
  });

  it("caches per-credential, per-resource triple — same creds + resource → 1 fetch", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T1"));
    const a = await getEntraTokenAs("c", "s", "api://x");
    const b = await getEntraTokenAs("c", "s", "api://x");
    expect(a).toBe("T1");
    expect(b).toBe("T1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rotating client_secret produces a different cache key", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T1"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T2"));
    expect(await getEntraTokenAs("c", "s1", "api://x")).toBe("T1");
    expect(await getEntraTokenAs("c", "s2", "api://x")).toBe("T2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("changing the resource produces a different cache key", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-A"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-B"));
    expect(await getEntraTokenAs("c", "s", "api://a")).toBe("T-A");
    expect(await getEntraTokenAs("c", "s", "api://b")).toBe("T-B");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearEntraTokenCacheFor evicts only the targeted entry", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T1"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T2-new"));
    await getEntraTokenAs("c", "s", "api://x");
    clearEntraTokenCacheFor("c", "s", "api://x");
    const after = await getEntraTokenAs("c", "s", "api://x");
    expect(after).toBe("T2-new");
  });

  it("throws when AZURE_TENANT_ID is missing", async () => {
    delete secretsState.AZURE_TENANT_ID;
    await expect(getEntraTokenAs("c", "s", "api://x")).rejects.toThrow(/Missing AZURE_TENANT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces non-2xx token-endpoint responses with the body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid_client", { status: 401 }));
    await expect(getEntraTokenAs("c", "wrong", "api://x")).rejects.toThrow(
      /Entra token request failed.*HTTP 401|401.*invalid_client/i,
    );
  });
});

// ── getInfosecAccessToken ────────────────────────────────────

describe("getInfosecAccessToken", () => {
  beforeEach(() => {
    secretsState.AZURE_TENANT_ID = "tenant-uuid";
    secretsState.AGENT_CLIENT_ID = "agent-app-reg-id";
    secretsState.AGENT_CLIENT_SECRET = "agent-secret";
    secretsState.INFOSEC_LOGIC_APP_API_ID = "logic-app-api-id";
  });

  it("builds the audience as 'api://<INFOSEC_LOGIC_APP_API_ID>'", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T1"));
    const token = await getInfosecAccessToken();
    expect(token).toBe("T1");
    const [, init] = fetchMock.mock.calls[0];
    const body = init?.body as URLSearchParams;
    expect(body.get("scope")).toBe("api://logic-app-api-id/.default");
    expect(body.get("client_id")).toBe("agent-app-reg-id");
    expect(body.get("client_secret")).toBe("agent-secret");
  });

  it("names the specific missing credential when AGENT_CLIENT_ID is unset", async () => {
    delete secretsState.AGENT_CLIENT_ID;
    await expect(getInfosecAccessToken()).rejects.toThrow(/Missing AGENT_CLIENT_ID/);
  });

  it("names the specific missing credential when AGENT_CLIENT_SECRET is unset", async () => {
    delete secretsState.AGENT_CLIENT_SECRET;
    await expect(getInfosecAccessToken()).rejects.toThrow(/Missing AGENT_CLIENT_SECRET/);
  });

  it("names the specific missing credential when INFOSEC_LOGIC_APP_API_ID is unset", async () => {
    delete secretsState.INFOSEC_LOGIC_APP_API_ID;
    await expect(getInfosecAccessToken()).rejects.toThrow(/Missing INFOSEC_LOGIC_APP_API_ID/);
  });

  it("clearInfosecTokenCache forces a re-mint on the next call", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T1"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T2"));
    expect(await getInfosecAccessToken()).toBe("T1");
    clearInfosecTokenCache();
    expect(await getInfosecAccessToken()).toBe("T2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Ultra-review MEDIUM #8: prefix-wipe handles rotation ──
  // After a SECRET ROTATION the new secrets compute to a different
  // sha256 cache key than the old ones, so a targeted eviction by
  // current creds is a no-op. clearInfosecTokenCache now uses
  // clearAllEntraTokenCache which is rotation-correct.
  it("clearInfosecTokenCache evicts a stale entry even after a credential rotation", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-OLD"));
    expect(await getInfosecAccessToken()).toBe("T-OLD");

    // Operator rotates AGENT_CLIENT_SECRET in Key Vault.
    secretsState.AGENT_CLIENT_SECRET = "agent-secret-NEW";

    // Without prefix-wipe, the cache key based on the new creds
    // wouldn't match the old entry, so the next call would simply
    // mint with the new creds — that's fine. But the OLD entry
    // would linger in memory until its natural expiry. With the
    // prefix-wipe fix, clearInfosecTokenCache evicts everything.
    clearInfosecTokenCache();

    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-NEW"));
    expect(await getInfosecAccessToken()).toBe("T-NEW");
    // The new fetch used the new secret.
    const newCallBody = fetchMock.mock.calls[1][1]?.body as URLSearchParams;
    expect(newCallBody.get("client_secret")).toBe("agent-secret-NEW");
  });
});

// ── Ultra-review MEDIUM #7: response-shape validation ────────
// A malformed 200 (e.g. proxy returning HTML or empty {}) would
// previously poison the cache with token=undefined / expiresAt=NaN
// and cause every later call to send "Authorization: Bearer
// undefined". The fix validates access_token and expires_in shape
// before caching.

describe("Entra token response shape validation", () => {
  beforeEach(() => {
    secretsState.AZURE_TENANT_ID = "tenant-uuid";
  });

  it("rejects a 200 response missing access_token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getEntraTokenAs("c", "s", "api://x")).rejects.toThrow(
      /missing or empty access_token/,
    );
  });

  it("rejects a 200 response with an empty-string access_token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getEntraTokenAs("c", "s", "api://x")).rejects.toThrow(
      /missing or empty access_token/,
    );
  });

  it("rejects a 200 response missing expires_in", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "T1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getEntraTokenAs("c", "s", "api://x")).rejects.toThrow(
      /missing or invalid expires_in/,
    );
  });

  it("rejects a 200 response with a non-positive expires_in", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "T1", expires_in: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getEntraTokenAs("c", "s", "api://x")).rejects.toThrow(
      /missing or invalid expires_in/,
    );
  });

  it("does NOT poison the cache when the response is malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getEntraTokenAs("c", "s", "api://x")).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-recover"));
    const after = await getEntraTokenAs("c", "s", "api://x");
    expect(after).toBe("T-recover");
  });
});

// ── Ultra-review MEDIUM #8: clearAllEntraTokenCache prefix wipe ──

describe("clearAllEntraTokenCache", () => {
  beforeEach(() => {
    secretsState.AZURE_TENANT_ID = "tenant-uuid";
  });

  it("evicts every entra:-prefixed entry but leaves targeted-eviction semantics intact", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-A1"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-B1"));
    expect(await getEntraTokenAs("c-A", "s", "api://x")).toBe("T-A1");
    expect(await getEntraTokenAs("c-B", "s", "api://y")).toBe("T-B1");

    clearAllEntraTokenCache();

    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-A2"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-B2"));
    expect(await getEntraTokenAs("c-A", "s", "api://x")).toBe("T-A2");
    expect(await getEntraTokenAs("c-B", "s", "api://y")).toBe("T-B2");
    // Both entries were re-minted.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("co-exists with clearEntraTokenCacheFor (targeted) without disturbing other entries", async () => {
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-A"));
    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-B"));
    await getEntraTokenAs("c-A", "s", "api://x");
    await getEntraTokenAs("c-B", "s", "api://y");

    // Targeted eviction of A only.
    clearEntraTokenCacheFor("c-A", "s", "api://x");

    fetchMock.mockResolvedValueOnce(entraTokenResponse("T-A2"));
    expect(await getEntraTokenAs("c-A", "s", "api://x")).toBe("T-A2");
    // B is still cached — no third fetch happened for B.
    expect(await getEntraTokenAs("c-B", "s", "api://y")).toBe("T-B");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
