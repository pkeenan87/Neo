import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Route-level tests for /api/admin/org-context:
//    - GET returns `backend: "blob" | "keyvault"` indicator
//    - GET reads from the correct backend
//    - PUT writes to the correct backend
//    - PUT clears the loader cache after save
//    - PUT refuses Key Vault writes above the 25 KB ceiling
// ─────────────────────────────────────────────────────────────

const {
  resolveAuthMock,
  blobConfigured,
  blobLoadMock,
  blobSaveMock,
  getToolSecretMock,
  setToolSecretMock,
  clearCacheMock,
} = vi.hoisted(() => ({
  resolveAuthMock: vi.fn(),
  blobConfigured: { value: false },
  blobLoadMock: vi.fn(),
  blobSaveMock: vi.fn(),
  getToolSecretMock: vi.fn(),
  setToolSecretMock: vi.fn(),
  clearCacheMock: vi.fn(),
}));

vi.mock("../lib/auth-helpers", () => ({
  resolveAuth: () => resolveAuthMock(),
}));

vi.mock("../lib/org-context-blob-store", () => ({
  isOrgContextBlobConfigured: () => blobConfigured.value,
  loadOrgContextFromBlob: () => blobLoadMock(),
  saveOrgContextToBlob: (text: string) => blobSaveMock(text),
}));

vi.mock("../lib/secrets", () => ({
  getToolSecret: (name: string) => getToolSecretMock(name),
  setToolSecret: (name: string, value: string) => setToolSecretMock(name, value),
}));

vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<typeof import("../lib/config")>("../lib/config");
  return {
    ...actual,
    ORG_NAME: "Test Org",
    clearOrgContextCache: () => clearCacheMock(),
  };
});

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
}));

const ADMIN_IDENTITY = {
  ownerId: "11111111-2222-3333-4444-555555555555",
  name: "admin@example.com",
  role: "admin" as const,
  provider: "entra-id" as const,
};

beforeEach(() => {
  resolveAuthMock.mockReset();
  blobConfigured.value = false;
  blobLoadMock.mockReset();
  blobSaveMock.mockReset();
  getToolSecretMock.mockReset();
  setToolSecretMock.mockReset();
  clearCacheMock.mockReset();
});

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/org-context", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost",
      host: "localhost",
    },
    body: JSON.stringify(body),
  });
}

function getRequest(): Request {
  return new Request("http://localhost/api/admin/org-context", { method: "GET" });
}

describe("GET /api/admin/org-context", () => {
  it("returns backend: 'blob' and reads from blob when configured", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = true;
    blobLoadMock.mockResolvedValue("FROM_BLOB");
    const { GET } = await import("../app/api/admin/org-context/route");
    const res = await GET(getRequest() as unknown as Parameters<typeof GET>[0]);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.backend).toBe("blob");
    expect(body.orgContext).toBe("FROM_BLOB");
    expect(blobLoadMock).toHaveBeenCalledTimes(1);
    expect(getToolSecretMock).not.toHaveBeenCalled();
  });

  it("returns backend: 'keyvault' and reads from KV when blob unconfigured", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = false;
    getToolSecretMock.mockResolvedValue("FROM_KV");
    const { GET } = await import("../app/api/admin/org-context/route");
    const res = await GET(getRequest() as unknown as Parameters<typeof GET>[0]);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.backend).toBe("keyvault");
    expect(body.orgContext).toBe("FROM_KV");
    expect(getToolSecretMock).toHaveBeenCalledTimes(1);
    expect(blobLoadMock).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin", async () => {
    resolveAuthMock.mockResolvedValue({ ...ADMIN_IDENTITY, role: "reader" });
    const { GET } = await import("../app/api/admin/org-context/route");
    const res = await GET(getRequest() as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/admin/org-context", () => {
  it("writes to blob and clears the cache when blob configured", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = true;
    blobSaveMock.mockResolvedValue(undefined);
    const { PUT } = await import("../app/api/admin/org-context/route");
    const res = await PUT(
      putRequest({ orgContext: "NEW_CONTEXT" }) as unknown as Parameters<typeof PUT>[0],
    );
    expect(res.status).toBe(200);
    expect(blobSaveMock).toHaveBeenCalledWith("NEW_CONTEXT");
    expect(setToolSecretMock).not.toHaveBeenCalled();
    expect(clearCacheMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.backend).toBe("blob");
  });

  it("writes to Key Vault when blob unconfigured", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = false;
    setToolSecretMock.mockResolvedValue(undefined);
    const { PUT } = await import("../app/api/admin/org-context/route");
    const res = await PUT(
      putRequest({ orgContext: "SMALL" }) as unknown as Parameters<typeof PUT>[0],
    );
    expect(res.status).toBe(200);
    expect(setToolSecretMock).toHaveBeenCalledWith("ORG_CONTEXT", "SMALL");
    expect(blobSaveMock).not.toHaveBeenCalled();
    expect(clearCacheMock).toHaveBeenCalledTimes(1);
  });

  it("rejects KV-tier writes above the 25 KB ceiling with 400", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = false;
    const oversized = "X".repeat(25_001);
    const { PUT } = await import("../app/api/admin/org-context/route");
    const res = await PUT(
      putRequest({ orgContext: oversized }) as unknown as Parameters<typeof PUT>[0],
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Key Vault tier limit/);
    expect(setToolSecretMock).not.toHaveBeenCalled();
    expect(clearCacheMock).not.toHaveBeenCalled();
  });

  it("accepts the same large content when blob backend is active", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = true;
    blobSaveMock.mockResolvedValue(undefined);
    const large = "X".repeat(50_000);
    const { PUT } = await import("../app/api/admin/org-context/route");
    const res = await PUT(
      putRequest({ orgContext: large }) as unknown as Parameters<typeof PUT>[0],
    );
    expect(res.status).toBe(200);
    expect(blobSaveMock).toHaveBeenCalledWith(large);
  });

  it("rejects content above ORG_CONTEXT_MAX_CHARS with 400 regardless of backend", async () => {
    resolveAuthMock.mockResolvedValue(ADMIN_IDENTITY);
    blobConfigured.value = true;
    const oversized = "X".repeat(100_001);
    const { PUT } = await import("../app/api/admin/org-context/route");
    const res = await PUT(
      putRequest({ orgContext: oversized }) as unknown as Parameters<typeof PUT>[0],
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds maximum length/);
    expect(blobSaveMock).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin", async () => {
    resolveAuthMock.mockResolvedValue({ ...ADMIN_IDENTITY, role: "reader" });
    const { PUT } = await import("../app/api/admin/org-context/route");
    const res = await PUT(
      putRequest({ orgContext: "x" }) as unknown as Parameters<typeof PUT>[0],
    );
    expect(res.status).toBe(403);
  });
});
