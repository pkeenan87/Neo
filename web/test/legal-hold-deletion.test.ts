import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Legal-hold enforcement on conversation deletion. Closes Law
//  Firm Critical C3 from the audit. The retentionClass="legal-hold"
//  setting is advisory until DELETE actively refuses; this suite
//  pins the route layer + store layer + LogEventType union shape.
// ─────────────────────────────────────────────────────────────

const {
  loggerMocks,
  resolveAuthMock,
  getConversationMock,
  deleteConversationMock,
  updateTitleMock,
} = vi.hoisted(() => {
  return {
    loggerMocks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      emitEvent: vi.fn(),
    },
    resolveAuthMock: vi.fn(),
    getConversationMock: vi.fn(),
    deleteConversationMock: vi.fn(),
    updateTitleMock: vi.fn(),
  };
});

vi.mock("../lib/logger", async () => {
  const actual = await vi.importActual<typeof import("../lib/logger")>("../lib/logger");
  return {
    ...actual,
    logger: loggerMocks,
    hashPii: actual.hashPii,
  };
});

vi.mock("../lib/auth-helpers", () => ({
  resolveAuth: () => resolveAuthMock(),
}));

vi.mock("../lib/conversation-store", () => ({
  getConversation: (...args: unknown[]) => getConversationMock(...args),
  deleteConversation: (...args: unknown[]) => deleteConversationMock(...args),
  updateTitle: (...args: unknown[]) => updateTitleMock(...args),
}));

vi.mock("../lib/conversation-store-mode", () => ({
  withStoreModeFromRequest: <T>(_req: unknown, _identity: unknown, fn: () => Promise<T>) => fn(),
}));

// Pin LegalHoldViolationError's module identity. Without this the
// route's `import { LegalHoldViolationError } from "@/lib/retention"`
// and the test's `import { LegalHoldViolationError } from "../lib/retention"`
// can resolve through different vitest module cache entries — `instanceof`
// then fails for an error thrown in the test even though the class
// "is" the same. Re-exporting the actual module here makes both
// import paths resolve to one shared module instance.
vi.mock("../lib/retention", async () => {
  return await vi.importActual<typeof import("../lib/retention")>("../lib/retention");
});

const TEST_OWNER_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
  loggerMocks.emitEvent.mockReset();
  resolveAuthMock.mockReset();
  getConversationMock.mockReset();
  deleteConversationMock.mockReset();
  updateTitleMock.mockReset();

  resolveAuthMock.mockResolvedValue({
    ownerId: TEST_OWNER_ID,
    name: "alice@example.com",
    role: "admin",
    provider: "entra-id",
  });
});

afterEach(() => {
  vi.resetModules();
});

import { LegalHoldViolationError } from "../lib/retention";
import type { LogEventType } from "../lib/types";

describe("LegalHoldViolationError", () => {
  it("is a typed error with the conversationId attached", () => {
    const err = new LegalHoldViolationError("conv-1");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LegalHoldViolationError");
    expect(err.conversationId).toBe("conv-1");
    expect(err.message).toContain("conv-1");
    expect(err.message).toContain("legal hold");
  });
});

describe("LogEventType union — legal_hold_violation", () => {
  it("accepts 'legal_hold_violation' as a valid event type", () => {
    // Compile-time check via a typed assignment.
    const ev: LogEventType = "legal_hold_violation";
    expect(ev).toBe("legal_hold_violation");
  });
});

describe("DELETE /api/conversations/[id] — legal-hold gate", () => {
  it("returns 423 and emits legal_hold_violation when retentionClass='legal-hold'", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv-1",
      ownerId: TEST_OWNER_ID,
      retentionClass: "legal-hold",
    });

    const { DELETE } = await import("../app/api/conversations/[id]/route");
    const req = new Request("http://localhost/api/conversations/conv-1", { method: "DELETE" });
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
      params: Promise.resolve({ id: "conv-1" }),
    });

    expect(res.status).toBe(423);
    expect(deleteConversationMock).not.toHaveBeenCalled();
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0];
    expect(eventType).toBe("legal_hold_violation");
    expect(metadata).toMatchObject({
      conversationId: "conv-1",
      retentionClass: "legal-hold",
      attempted: "delete",
      role: "admin",
    });
    // Owner id must be hashed, not raw.
    expect(metadata.ownerIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(metadata)).not.toContain(TEST_OWNER_ID);
  });

  it("succeeds (204) for retentionClass='standard-7y' (no regression)", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv-2",
      ownerId: TEST_OWNER_ID,
      retentionClass: "standard-7y",
    });
    deleteConversationMock.mockResolvedValue(undefined);

    const { DELETE } = await import("../app/api/conversations/[id]/route");
    const req = new Request("http://localhost/api/conversations/conv-2", { method: "DELETE" });
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
      params: Promise.resolve({ id: "conv-2" }),
    });

    expect(res.status).toBe(204);
    expect(deleteConversationMock).toHaveBeenCalledOnce();
    expect(loggerMocks.emitEvent).not.toHaveBeenCalled();
  });

  it("succeeds (204) for retentionClass='transient' and 'client-matter'", async () => {
    for (const retentionClass of ["transient", "client-matter"] as const) {
      getConversationMock.mockResolvedValue({
        id: "conv-3",
        ownerId: TEST_OWNER_ID,
        retentionClass,
      });
      deleteConversationMock.mockResolvedValue(undefined);

      const { DELETE } = await import("../app/api/conversations/[id]/route");
      const req = new Request("http://localhost/api/conversations/conv-3", { method: "DELETE" });
      const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
        params: Promise.resolve({ id: "conv-3" }),
      });

      expect(res.status, `class=${retentionClass}`).toBe(204);
    }
  });

  it("catches LegalHoldViolationError thrown by the store layer and returns 423 (defense-in-depth)", async () => {
    // Simulate the route's pre-check seeing a stale class while the
    // store-layer fresher read sees legal-hold.
    getConversationMock.mockResolvedValue({
      id: "conv-4",
      ownerId: TEST_OWNER_ID,
      retentionClass: "standard-7y", // route-level read says standard
    });
    deleteConversationMock.mockRejectedValue(
      new LegalHoldViolationError("conv-4", "legal-hold", "delete"),
    );

    const { DELETE } = await import("../app/api/conversations/[id]/route");
    const req = new Request("http://localhost/api/conversations/conv-4", { method: "DELETE" });
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], {
      params: Promise.resolve({ id: "conv-4" }),
    });

    expect(res.status).toBe(423);
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0];
    expect(eventType).toBe("legal_hold_violation");
    // The audit event must reflect the truthful class from the error,
    // not the stale value from the route-level read.
    expect(metadata.retentionClass).toBe("legal-hold");
    expect(metadata.attempted).toBe("delete");
  });
});

describe("PATCH /api/conversations/[id] — legal-hold gate (rename)", () => {
  it("returns 423 + emits legal_hold_violation when retentionClass='legal-hold'", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv-h",
      ownerId: TEST_OWNER_ID,
      retentionClass: "legal-hold",
    });

    const { PATCH } = await import("../app/api/conversations/[id]/route");
    const req = new Request("http://localhost/api/conversations/conv-h", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    const res = await PATCH(req as unknown as Parameters<typeof PATCH>[0], {
      params: Promise.resolve({ id: "conv-h" }),
    });

    expect(res.status).toBe(423);
    expect(updateTitleMock).not.toHaveBeenCalled();
    expect(loggerMocks.emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0];
    expect(eventType).toBe("legal_hold_violation");
    expect(metadata).toMatchObject({
      conversationId: "conv-h",
      retentionClass: "legal-hold",
      attempted: "rename",
    });
  });

  it("succeeds (200) for retentionClass='standard-7y'", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv-ok",
      ownerId: TEST_OWNER_ID,
      retentionClass: "standard-7y",
    });
    updateTitleMock.mockResolvedValue(undefined);

    const { PATCH } = await import("../app/api/conversations/[id]/route");
    const req = new Request("http://localhost/api/conversations/conv-ok", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    const res = await PATCH(req as unknown as Parameters<typeof PATCH>[0], {
      params: Promise.resolve({ id: "conv-ok" }),
    });

    expect(res.status).toBe(200);
    expect(updateTitleMock).toHaveBeenCalledOnce();
    expect(loggerMocks.emitEvent).not.toHaveBeenCalled();
  });

  it("catches LegalHoldViolationError from the store layer and returns 423 with truthful class", async () => {
    getConversationMock.mockResolvedValue({
      id: "conv-race",
      ownerId: TEST_OWNER_ID,
      retentionClass: "standard-7y",
    });
    updateTitleMock.mockRejectedValue(
      new LegalHoldViolationError("conv-race", "legal-hold", "rename"),
    );

    const { PATCH } = await import("../app/api/conversations/[id]/route");
    const req = new Request("http://localhost/api/conversations/conv-race", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    const res = await PATCH(req as unknown as Parameters<typeof PATCH>[0], {
      params: Promise.resolve({ id: "conv-race" }),
    });

    expect(res.status).toBe(423);
    const [eventType, , , metadata] = loggerMocks.emitEvent.mock.calls[0];
    expect(eventType).toBe("legal_hold_violation");
    expect(metadata.retentionClass).toBe("legal-hold");
    expect(metadata.attempted).toBe("rename");
  });
});
