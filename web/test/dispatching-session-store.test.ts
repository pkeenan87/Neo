import { describe, it, expect, vi, beforeEach } from "vitest";

// The DispatchingSessionStore wraps a CosmosSessionStore (v1) and a
// CosmosV2SessionStore (v2). We mock BOTH entirely — this test
// verifies the DISPATCH WIRING, not the v1/v2 store internals, which
// are covered by their own test files.

// Using unknown-typed factories so per-test `.mockResolvedValueOnce`
// calls can return typed values (Session, PendingTool, etc.) without
// fighting TypeScript's inference from the initial async () => null.
const { v1Spies, v2Spies } = vi.hoisted(() => {
  const make = () => ({
    create: vi.fn(async (): Promise<string> => "conv_minted"),
    get: vi.fn(async (): Promise<unknown> => undefined),
    getExpired: vi.fn(async (): Promise<unknown> => undefined),
    delete: vi.fn(async (): Promise<boolean> => true),
    list: vi.fn(async (): Promise<unknown[]> => []),
    listForOwner: vi.fn(async (): Promise<unknown[]> => []),
    setPendingConfirmation: vi.fn(async (): Promise<void> => {}),
    clearPendingConfirmation: vi.fn(async (): Promise<unknown> => null),
    isRateLimited: vi.fn(async (): Promise<boolean> => false),
    saveMessages: vi.fn(async (): Promise<void> => {}),
    updateTitle: vi.fn(async (): Promise<void> => {}),
  });
  const v1Spies = make();
  const v2Spies = make();
  // v2.create separately defaults to a v2-specific id so tests can
  // distinguish which store minted the id.
  v2Spies.create = vi.fn(async () => "conv_v2minted");
  v1Spies.create = vi.fn(async () => "conv_v1minted");
  return { v1Spies, v2Spies };
});

vi.mock("../lib/conversation-store", () => ({
  CosmosSessionStore: class {
    create = v1Spies.create;
    get = v1Spies.get;
    getExpired = v1Spies.getExpired;
    delete = v1Spies.delete;
    list = v1Spies.list;
    listForOwner = v1Spies.listForOwner;
    setPendingConfirmation = v1Spies.setPendingConfirmation;
    clearPendingConfirmation = v1Spies.clearPendingConfirmation;
    isRateLimited = v1Spies.isRateLimited;
    saveMessages = v1Spies.saveMessages;
    updateTitle = v1Spies.updateTitle;
  },
}));

const { mockCreateV2WithId } = vi.hoisted(() => ({
  mockCreateV2WithId: vi.fn(async (id: string) => id),
}));

vi.mock("../lib/conversation-store-v2", () => ({
  CosmosV2SessionStore: class {
    create = v2Spies.create;
    get = v2Spies.get;
    getExpired = v2Spies.getExpired;
    delete = v2Spies.delete;
    list = v2Spies.list;
    listForOwner = v2Spies.listForOwner;
    setPendingConfirmation = v2Spies.setPendingConfirmation;
    clearPendingConfirmation = v2Spies.clearPendingConfirmation;
    isRateLimited = v2Spies.isRateLimited;
    saveMessages = v2Spies.saveMessages;
    updateTitle = v2Spies.updateTitle;
  },
  createConversationV2WithId: mockCreateV2WithId,
}));

vi.mock("../lib/config", () => ({
  env: {
    COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/",
    MOCK_MODE: false,
  },
  NEO_CONVERSATION_STORE_MODE: "v1",
}));

const { mockWarn, mockEmitEvent } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockEmitEvent: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    warn: mockWarn,
    emitEvent: mockEmitEvent,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

// mockStore is returned by the factory when not in Cosmos mode; we
// aren't exercising that path here but the module must resolve.
vi.mock("../lib/mock-conversation-store", () => ({
  mockStore: {},
}));

import { DispatchingSessionStore } from "../lib/session-factory";
import { __forceStoreModeForTest } from "../lib/conversation-store-mode";
import type { Message } from "../lib/types";
// CsvAttachmentCapError would be imported here if we exercised it,
// but the session-store interface has no CSV-attachment method —
// conversation-store.ts dispatch tests cover that path instead.

function resetAll() {
  for (const spy of Object.values(v1Spies)) (spy as ReturnType<typeof vi.fn>).mockClear();
  for (const spy of Object.values(v2Spies)) (spy as ReturnType<typeof vi.fn>).mockClear();
  mockCreateV2WithId.mockClear();
  mockWarn.mockReset();
  mockEmitEvent.mockReset();
}

async function inMode<T>(
  mode: "v1" | "v2" | "dual-read" | "dual-write",
  fn: () => Promise<T>,
): Promise<T> {
  return (await __forceStoreModeForTest(mode, fn)) as T;
}

describe("DispatchingSessionStore", () => {
  const store = new DispatchingSessionStore();

  beforeEach(resetAll);

  describe("v1 mode", () => {
    it("every method delegates to v1, v2 untouched", async () => {
      await inMode("v1", async () => {
        await store.create("reader", "owner_1", "web");
        await store.get("id_1");
        await store.getExpired("id_1");
        await store.saveMessages("id_1", []);
        await store.updateTitle("id_1", "T");
        await store.setPendingConfirmation("id_1", {
          id: "tu",
          name: "t",
          input: {},
        });
        await store.clearPendingConfirmation("id_1");
        await store.isRateLimited("id_1");
        await store.delete("id_1");
        await store.list();
        await store.listForOwner("owner_1");
      });
      expect(v1Spies.create).toHaveBeenCalled();
      expect(v1Spies.get).toHaveBeenCalled();
      expect(v1Spies.saveMessages).toHaveBeenCalled();
      // v2 never touched under v1 mode.
      for (const spy of Object.values(v2Spies)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe("v2 mode", () => {
    it("every method delegates to v2, v1 untouched", async () => {
      await inMode("v2", async () => {
        await store.create("reader", "owner_1", "web");
        await store.get("id_1");
        await store.getExpired("id_1");
        await store.saveMessages("id_1", []);
        await store.updateTitle("id_1", "T");
        await store.setPendingConfirmation("id_1", {
          id: "tu",
          name: "t",
          input: {},
        });
        await store.clearPendingConfirmation("id_1");
        await store.isRateLimited("id_1");
        await store.delete("id_1");
      });
      expect(v2Spies.create).toHaveBeenCalled();
      expect(v2Spies.saveMessages).toHaveBeenCalled();
      expect(v2Spies.updateTitle).toHaveBeenCalled();
      for (const [name, spy] of Object.entries(v1Spies)) {
        expect(spy, `v1.${name} should not fire under v2 mode`).not.toHaveBeenCalled();
      }
    });
  });

  describe("dual-read mode", () => {
    it("get: v2 hit returns v2 directly, v1 NOT consulted", async () => {
      v2Spies.get.mockResolvedValueOnce({ id: "v2hit" } as never);
      const out = await inMode("dual-read", () => store.get("id_1"));
      expect((out as { id: string } | undefined)?.id).toBe("v2hit");
      expect(v1Spies.get).not.toHaveBeenCalled();
    });

    it("get: v2 miss falls back to v1", async () => {
      v2Spies.get.mockResolvedValueOnce(undefined);
      v1Spies.get.mockResolvedValueOnce({ id: "v1fallback" } as never);
      const out = await inMode("dual-read", () => store.get("id_1"));
      expect((out as { id: string } | undefined)?.id).toBe("v1fallback");
      expect(v1Spies.get).toHaveBeenCalledTimes(1);
    });

    it("getExpired: same v2-first, v1-fallback pattern", async () => {
      v2Spies.getExpired.mockResolvedValueOnce(undefined);
      v1Spies.getExpired.mockResolvedValueOnce({ id: "expired" } as never);
      const out = await inMode("dual-read", () => store.getExpired("id_1"));
      expect((out as { id: string } | undefined)?.id).toBe("expired");
    });

    it("saveMessages: writes to v2 only (v1 NOT consulted)", async () => {
      const msgs: Message[] = [{ role: "user", content: "hi" }];
      await inMode("dual-read", () => store.saveMessages("id_1", msgs));
      expect(v2Spies.saveMessages).toHaveBeenCalledWith("id_1", msgs, undefined);
      expect(v1Spies.saveMessages).not.toHaveBeenCalled();
    });

    it("isRateLimited: ORs both stores (either at cap counts)", async () => {
      v1Spies.isRateLimited.mockResolvedValueOnce(false);
      v2Spies.isRateLimited.mockResolvedValueOnce(true);
      expect(
        await inMode("dual-read", () => store.isRateLimited("id_1")),
      ).toBe(true);
    });

    it("list: merges + dedupes by id; logs divergence when v1 has duplicate ids", async () => {
      v2Spies.list.mockResolvedValueOnce([
        { id: "shared", role: "reader", ownerId: "o", createdAt: new Date(), messageCount: 0 },
        { id: "v2only", role: "reader", ownerId: "o", createdAt: new Date(), messageCount: 0 },
      ] as never);
      v1Spies.list.mockResolvedValueOnce([
        { id: "shared", role: "reader", ownerId: "o", createdAt: new Date(), messageCount: 0 },
        { id: "v1only", role: "reader", ownerId: "o", createdAt: new Date(), messageCount: 0 },
      ] as never);
      const out = await inMode("dual-read", () => store.list());
      const ids = out.map((s) => s.id);
      expect(ids).toEqual(["shared", "v2only", "v1only"]);
      // Divergence on "shared" logged.
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("v1 ids also present in v2"),
        "session-factory",
        expect.objectContaining({ duplicateIds: ["shared"] }),
      );
    });

    it("listForOwner: same merge semantics, hashes ownerId in divergence log", async () => {
      v2Spies.listForOwner.mockResolvedValueOnce([
        { id: "X", role: "reader", ownerId: "o", createdAt: new Date(), messageCount: 0 },
      ] as never);
      v1Spies.listForOwner.mockResolvedValueOnce([
        { id: "X", role: "reader", ownerId: "o", createdAt: new Date(), messageCount: 0 },
      ] as never);
      await inMode("dual-read", () => store.listForOwner("owner_1"));
      expect(mockWarn).toHaveBeenCalledWith(
        expect.any(String),
        "session-factory",
        expect.objectContaining({
          duplicateIds: ["X"],
          ownerIdHash: "hash(owner_1)",
        }),
      );
    });
  });

  describe("dual-write mode", () => {
    it("create: v1 mints id; v2 mirrors via createConversationV2WithId (NOT v2.create)", async () => {
      v1Spies.create.mockResolvedValueOnce("conv_shared-id");
      const id = await inMode("dual-write", () =>
        store.create("reader", "owner_1", "web"),
      );
      expect(id).toBe("conv_shared-id");
      expect(v1Spies.create).toHaveBeenCalledTimes(1);
      expect(mockCreateV2WithId).toHaveBeenCalledWith(
        "conv_shared-id",
        "owner_1",
        "reader",
        "web",
      );
      // v2.create MUST NOT be called (that would mint a second id).
      expect(v2Spies.create).not.toHaveBeenCalled();
    });

    it("saveMessages: writes to BOTH with matching args", async () => {
      const msgs: Message[] = [{ role: "user", content: "hi" }];
      await inMode("dual-write", () =>
        store.saveMessages("id_1", msgs, "Title"),
      );
      expect(v1Spies.saveMessages).toHaveBeenCalledWith("id_1", msgs, "Title");
      expect(v2Spies.saveMessages).toHaveBeenCalledWith("id_1", msgs, "Title");
    });

    it("updateTitle: writes to both; v1 authoritative (return value from v1)", async () => {
      await inMode("dual-write", () => store.updateTitle("id_1", "New"));
      expect(v1Spies.updateTitle).toHaveBeenCalledWith("id_1", "New");
      expect(v2Spies.updateTitle).toHaveBeenCalledWith("id_1", "New");
    });

    it("clearPendingConfirmation: return value comes from v1, v2 best-effort", async () => {
      const tool = { id: "tu", name: "t", input: {} };
      v1Spies.clearPendingConfirmation.mockResolvedValueOnce(tool);
      v2Spies.clearPendingConfirmation.mockResolvedValueOnce(null);
      const out = await inMode("dual-write", () =>
        store.clearPendingConfirmation("id_1"),
      );
      expect(out).toEqual(tool);
      expect(v1Spies.clearPendingConfirmation).toHaveBeenCalledTimes(1);
      expect(v2Spies.clearPendingConfirmation).toHaveBeenCalledTimes(1);
    });

    it("v2 write failure does NOT throw; v1 return value preserved; divergence event fires", async () => {
      v2Spies.updateTitle.mockRejectedValueOnce(new Error("v2 down"));
      await expect(
        inMode("dual-write", () => store.updateTitle("id_1", "T")),
      ).resolves.not.toThrow();
      expect(v1Spies.updateTitle).toHaveBeenCalledTimes(1);
      expect(mockEmitEvent).toHaveBeenCalledWith(
        "conversation_dual_write_divergence",
        expect.any(String),
        "session-factory",
        expect.objectContaining({
          operation: "updateTitle",
          conversationId: "id_1",
        }),
      );
    });

    it("isRateLimited: unions v1 + v2 (security fail-safe for sessions born under dual-read)", async () => {
      // Session born under dual-read is v2-only. Under dual-write the
      // naive implementation would read v1 and return false — that's a
      // false negative on a security control. Union must catch it.
      v1Spies.isRateLimited.mockResolvedValueOnce(false);
      v2Spies.isRateLimited.mockResolvedValueOnce(true);
      expect(
        await inMode("dual-write", () => store.isRateLimited("id_1")),
      ).toBe(true);
    });

    it("non-CsvAttachmentCapError failures from v2 are swallowed as divergence", async () => {
      v2Spies.updateTitle.mockRejectedValueOnce(
        Object.assign(new Error("cosmos 503"), { code: 503 }),
      );
      await expect(
        inMode("dual-write", () => store.updateTitle("id_1", "T")),
      ).resolves.not.toThrow();
      expect(mockEmitEvent).toHaveBeenCalledWith(
        "conversation_dual_write_divergence",
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
