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
    await clearInfosecTokenCache();
    expect(await getInfosecAccessToken()).toBe("T2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
