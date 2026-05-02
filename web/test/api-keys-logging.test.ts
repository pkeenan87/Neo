import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  POST /api/api-keys and DELETE /api/api-keys/[id] must log
//  the hashed ownerId, never the raw UPN/email. Closes the
//  Security Medium finding from the audit (logger contract at
//  web/lib/logger.ts:100-103 says "MUST hash with hashPii()").
// ─────────────────────────────────────────────────────────────

const { loggerMocks, resolveAuthMock, createApiKeyMock, revokeApiKeyMock } = vi.hoisted(() => {
  return {
    loggerMocks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      emitEvent: vi.fn(),
    },
    resolveAuthMock: vi.fn(),
    createApiKeyMock: vi.fn(),
    revokeApiKeyMock: vi.fn(),
  };
});

vi.mock("../lib/logger", async () => {
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  return {
    ...actual,
    logger: loggerMocks,
    // Keep the real hashPii so we can assert on its actual output shape.
    hashPii: actual.hashPii,
  };
});

vi.mock("../lib/auth-helpers", () => ({
  resolveAuth: () => resolveAuthMock(),
}));

vi.mock("../lib/api-key-store", () => ({
  ApiKeyValidationError: class ApiKeyValidationError extends Error {},
  MAX_API_KEY_LIFETIME_MS: 2 * 365 * 24 * 60 * 60 * 1000,
  listApiKeys: vi.fn(async () => []),
  createApiKey: (...args: unknown[]) => createApiKeyMock(...args),
  revokeApiKey: (...args: unknown[]) => revokeApiKeyMock(...args),
}));

const TEST_OWNER_ID = "11111111-2222-3333-4444-555555555555";
const TEST_UPN = "alice@example.com";

beforeEach(() => {
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
  loggerMocks.debug.mockReset();
  resolveAuthMock.mockReset();
  createApiKeyMock.mockReset();
  revokeApiKeyMock.mockReset();

  resolveAuthMock.mockResolvedValue({
    ownerId: TEST_OWNER_ID,
    name: TEST_UPN,
    role: "admin",
    provider: "entra-id",
  });
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /api/api-keys — UPN hashing", () => {
  it("logs hashPii(ownerId) as createdBy and never the raw UPN", async () => {
    createApiKeyMock.mockResolvedValue({
      record: { id: "abcdef", label: "ci-bot", role: "reader" },
      plaintext: "neo_xxx",
    });

    const { POST } = await import("../app/api/api-keys/route");
    const req = new Request("http://localhost/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "ci-bot", role: "reader" }),
    });
    await POST(req as unknown as Parameters<typeof POST>[0]);

    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    const [, , metadata] = loggerMocks.info.mock.calls[0];
    expect(metadata.createdBy).toMatch(/^[0-9a-f]{16}$/);
    expect(metadata.createdBy).not.toBe(TEST_UPN);
    expect(JSON.stringify(metadata)).not.toContain(TEST_UPN);
    expect(JSON.stringify(metadata)).not.toContain("@");
  });
});

describe("DELETE /api/api-keys/[id] — UPN hashing", () => {
  it("logs hashPii(ownerId) as revokedBy and never the raw UPN", async () => {
    revokeApiKeyMock.mockResolvedValue(undefined);

    const { DELETE } = await import("../app/api/api-keys/[id]/route");
    const id = "a".repeat(64);
    const req = new Request(`http://localhost/api/api-keys/${id}`, { method: "DELETE" });
    await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
      params: Promise.resolve({ id }),
    });

    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    const [, , metadata] = loggerMocks.info.mock.calls[0];
    expect(metadata.revokedBy).toMatch(/^[0-9a-f]{16}$/);
    expect(metadata.revokedBy).not.toBe(TEST_UPN);
    expect(JSON.stringify(metadata)).not.toContain(TEST_UPN);
    expect(JSON.stringify(metadata)).not.toContain("@");
  });
});
