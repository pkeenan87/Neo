import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config so the dispatcher reads a deterministic default mode.
// The real mode is overridden per-test via __forceStoreModeForTest.
vi.mock("../lib/config", () => ({
  env: {
    COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/",
    MOCK_MODE: false,
  },
  NEO_CONVERSATION_STORE_MODE: "v1",
  NEO_CONVERSATIONS_V2_CONTAINER: "neo-conversations-v2",
  NEO_RETENTION_CLASS_DEFAULT: "standard-7y",
  PERSISTENCE_TOOL_RESULT_TOKEN_CAP: 10_000,
}));

// Silence + spy on logger.
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

// Stub context-manager so truncateToolResults is a no-op.
vi.mock("../lib/context-manager", () => ({
  truncateToolResults: (messages: unknown[]) => ({
    messages,
    anyTruncated: false,
  }),
  CHARS_PER_TOKEN: 4,
}));

// Stub mock-conversation-store so useMock() path is never hit. The
// dispatcher is tested with Cosmos configured + MOCK_MODE false, so
// we shouldn't see these called. The mock itself is covered by its
// own tests.
vi.mock("../lib/mock-conversation-store", () => ({
  mockStore: {
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    listConversations: vi.fn(),
    appendMessages: vi.fn(),
    updateConversationTitle: vi.fn(),
    deleteConversation: vi.fn(),
    setConversationPendingConfirmation: vi.fn(),
    clearConversationPendingConfirmation: vi.fn(),
    appendCsvAttachment: vi.fn(),
  },
}));

// Stub the v2 module — we assert which v2 functions got called under
// each mode. Using vi.hoisted so we can reference these spies inside
// the module factory (avoids the "access before initialization" trap).
const { v2Spies } = vi.hoisted(() => {
  const make = () => vi.fn(async () => undefined);
  return {
    v2Spies: {
      createConversationV2: vi.fn(async () => "conv_v2minted"),
      createConversationV2WithId: vi.fn(async (id: string) => id),
      getConversationV2: vi.fn(async () => null),
      listConversationsV2: vi.fn(async () => []),
      appendMessagesV2: make(),
      updateTitleV2: make(),
      deleteConversationV2: make(),
      setConversationPendingConfirmationV2: make(),
      clearConversationPendingConfirmationV2: vi.fn(async () => null),
      appendCsvAttachmentV2: make(),
    },
  };
});
vi.mock("../lib/conversation-store-v2", () => v2Spies);

// Stub the Azure SDKs so no real Cosmos client is instantiated.
// We provide just enough surface that the v1 inline code can read /
// write against an in-memory map (so v1-authoritative dual-write
// tests can actually observe v1 writing successfully).
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {},
}));

const { v1Store } = vi.hoisted(() => ({
  v1Store: new Map<string, Map<string, unknown>>(),
}));

function getV1Partition(pk: string): Map<string, unknown> {
  if (!v1Store.has(pk)) v1Store.set(pk, new Map());
  return v1Store.get(pk)!;
}

vi.mock("@azure/cosmos", () => {
  class FakeContainer {
    items = {
      async create<T extends { id: string; ownerId?: string }>(doc: T) {
        const pk = doc.ownerId ?? doc.id;
        getV1Partition(pk).set(doc.id, doc);
        return { resource: doc };
      },
      query<T>(_q: unknown) {
        return {
          async fetchAll(): Promise<{ resources: T[] }> {
            const all: T[] = [];
            for (const [, p] of v1Store) {
              for (const [, d] of p) all.push(d as T);
            }
            return { resources: all };
          },
        };
      },
    };
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const doc = getV1Partition(pk).get(id);
          return { resource: doc as T | undefined, etag: doc ? "fake-etag" : undefined };
        },
        async replace(doc: { id: string }, _opts?: unknown) {
          getV1Partition(pk).set(doc.id, doc);
          return { resource: doc };
        },
        async delete() {
          getV1Partition(pk).delete(id);
          return { code: 204 };
        },
      };
    }
  }
  class FakeClient {
    constructor(_opts: unknown) {}
    database(_name: string) {
      return { container: (_c: string) => new FakeContainer() };
    }
  }
  return { CosmosClient: FakeClient };
});

// Stub truncate/injection dependencies the v1 path pulls in transitively.
vi.mock("../lib/injection-guard", () => ({
  wrapToolResult: (_n: string, result: unknown) => JSON.stringify(result ?? {}),
}));

import {
  createConversation,
  getConversation,
  listConversations,
  appendMessages,
  updateTitle,
  deleteConversation,
  setConversationPendingConfirmation,
  clearConversationPendingConfirmation,
  appendCsvAttachment,
} from "../lib/conversation-store";
import { __forceStoreModeForTest } from "../lib/conversation-store-mode";
import type { Message, PendingTool, CSVReference } from "../lib/types";

// Every test runs `fn` inside a specific mode context. Keeps the
// setup terse and matches the real request-scoped dispatch path.
async function inMode<T>(
  mode: "v1" | "v2" | "dual-read" | "dual-write",
  fn: () => Promise<T>,
): Promise<T> {
  return (await __forceStoreModeForTest(mode, fn)) as T;
}

function resetAll() {
  v1Store.clear();
  Object.values(v2Spies).forEach((s) => s.mockClear());
  mockWarn.mockReset();
  mockEmitEvent.mockReset();
}

describe("conversation-store dispatch", () => {
  beforeEach(resetAll);

  describe("v1 mode", () => {
    it("createConversation writes to v1 only", async () => {
      const id = await inMode("v1", () =>
        createConversation("owner_1", "reader", "web"),
      );
      expect(id).toMatch(/^conv_/);
      expect(v2Spies.createConversationV2).not.toHaveBeenCalled();
      expect(v2Spies.createConversationV2WithId).not.toHaveBeenCalled();
      // v1 doc exists in the fake Cosmos store under ownerId partition.
      const partition = v1Store.get("owner_1");
      expect(partition?.has(id)).toBe(true);
    });

    it("getConversation reads from v1 only", async () => {
      const id = await inMode("v1", () =>
        createConversation("owner_1", "reader", "web"),
      );
      const conv = await inMode("v1", () => getConversation(id, "owner_1"));
      expect(conv?.id).toBe(id);
      expect(v2Spies.getConversationV2).not.toHaveBeenCalled();
    });
  });

  describe("v2 mode", () => {
    it("createConversation delegates to v2 only (v1 untouched)", async () => {
      const id = await inMode("v2", () =>
        createConversation("owner_1", "reader", "web"),
      );
      expect(id).toBe("conv_v2minted");
      expect(v2Spies.createConversationV2).toHaveBeenCalledTimes(1);
      // v1 partition stays empty.
      expect(v1Store.size).toBe(0);
    });

    it("getConversation delegates to v2 only", async () => {
      await inMode("v2", () => getConversation("conv_x", "owner_1"));
      expect(v2Spies.getConversationV2).toHaveBeenCalledWith("conv_x", "owner_1");
    });

    it("appendMessages, updateTitle, deleteConversation all delegate to v2", async () => {
      const msgs: Message[] = [{ role: "user", content: "hi" }];
      await inMode("v2", async () => {
        await appendMessages("conv_x", "owner_1", msgs);
        await updateTitle("conv_x", "owner_1", "T");
        await deleteConversation("conv_x", "owner_1");
      });
      expect(v2Spies.appendMessagesV2).toHaveBeenCalledTimes(1);
      expect(v2Spies.updateTitleV2).toHaveBeenCalledTimes(1);
      expect(v2Spies.deleteConversationV2).toHaveBeenCalledTimes(1);
      // v1 store untouched.
      expect(v1Store.size).toBe(0);
    });
  });

  describe("dual-read mode", () => {
    it("getConversation: v2 hit returns v2 directly (v1 never queried)", async () => {
      v2Spies.getConversationV2.mockResolvedValueOnce({
        id: "conv_v2",
        ownerId: "owner_1",
      } as never);
      const out = await inMode("dual-read", () =>
        getConversation("conv_v2", "owner_1"),
      );
      expect(out?.id).toBe("conv_v2");
      expect(v2Spies.getConversationV2).toHaveBeenCalled();
    });

    it("getConversation: v2 miss falls back to v1", async () => {
      // Seed v1 with a real doc.
      const id = await inMode("v1", () =>
        createConversation("owner_1", "reader", "web"),
      );
      v2Spies.getConversationV2.mockResolvedValueOnce(null);
      const conv = await inMode("dual-read", () => getConversation(id, "owner_1"));
      expect(conv?.id).toBe(id);
      expect(v2Spies.getConversationV2).toHaveBeenCalled();
    });

    it("writes go to v2 only (v1 untouched)", async () => {
      await inMode("dual-read", () =>
        appendMessages("conv_x", "owner_1", [{ role: "user", content: "hi" }]),
      );
      expect(v2Spies.appendMessagesV2).toHaveBeenCalledTimes(1);
      expect(v1Store.size).toBe(0);
    });
  });

  describe("dual-write mode", () => {
    it("createConversation: v1 mints the id; v2 mirrors with createConversationV2WithId", async () => {
      const id = await inMode("dual-write", () =>
        createConversation("owner_1", "reader", "web"),
      );
      expect(v2Spies.createConversationV2WithId).toHaveBeenCalledWith(
        id,
        "owner_1",
        "reader",
        "web",
        undefined,
      );
      expect(v2Spies.createConversationV2).not.toHaveBeenCalled();
      expect(v1Store.get("owner_1")?.has(id)).toBe(true);
    });

    it("writes to v1 AND v2 — v1 authoritative, v2 best-effort", async () => {
      const id = await inMode("dual-write", () =>
        createConversation("owner_1", "reader", "web"),
      );
      await inMode("dual-write", () =>
        updateTitle(id, "owner_1", "New Title"),
      );
      expect(v2Spies.updateTitleV2).toHaveBeenCalledTimes(1);
      // v1 doc has the new title.
      const doc = v1Store.get("owner_1")?.get(id) as { title?: string };
      expect(doc?.title).toBe("New Title");
    });

    it("v2 write failure does NOT throw; logs conversation_dual_write_divergence", async () => {
      v2Spies.updateTitleV2.mockRejectedValueOnce(new Error("v2 cosmos down"));
      // Seed a v1 doc first.
      const id = await inMode("v1", () =>
        createConversation("owner_1", "reader", "web"),
      );
      // Now under dual-write, the v2 side fails but v1 succeeds.
      await expect(
        inMode("dual-write", () => updateTitle(id, "owner_1", "X")),
      ).resolves.not.toThrow();
      expect(mockEmitEvent).toHaveBeenCalledWith(
        "conversation_dual_write_divergence",
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          operation: "updateTitle",
          conversationId: id,
        }),
      );
    });

    it("reads come from v1 only (v2 NOT consulted)", async () => {
      const id = await inMode("v1", () =>
        createConversation("owner_1", "reader", "web"),
      );
      await inMode("dual-write", () => getConversation(id, "owner_1"));
      expect(v2Spies.getConversationV2).not.toHaveBeenCalled();
    });
  });
});
