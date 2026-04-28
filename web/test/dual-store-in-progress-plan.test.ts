import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InProgressPlan } from "../lib/types";

// Config with storage v1 default — tests override via __forceStoreModeForTest.
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

const { mockWarn, mockEmitEvent } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockEmitEvent: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: { warn: mockWarn, emitEvent: mockEmitEvent, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

vi.mock("../lib/context-manager", () => ({
  truncateToolResults: (messages: unknown[]) => ({ messages, anyTruncated: false }),
  CHARS_PER_TOKEN: 4,
}));

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
    setConversationInProgressPlan: vi.fn(),
    getConversationInProgressPlan: vi.fn(async () => null),
  },
}));

// v2 module — spy on setConversationInProgressPlanV2.
const { v2Spies, FakeConversationNotFoundV2Error } = vi.hoisted(() => {
  class FakeConversationNotFoundV2Error extends Error {
    readonly conversationId: string;
    constructor(conversationId: string) {
      super(`Conversation ${conversationId} not found (v2)`);
      this.name = "ConversationNotFoundV2Error";
      this.conversationId = conversationId;
    }
  }
  return {
    v2Spies: {
      createConversationV2: vi.fn(),
      createConversationV2WithId: vi.fn(),
      getConversationV2: vi.fn(async () => null),
      listConversationsV2: vi.fn(async () => []),
      appendMessagesV2: vi.fn(),
      updateTitleV2: vi.fn(),
      deleteConversationV2: vi.fn(),
      setConversationPendingConfirmationV2: vi.fn(),
      clearConversationPendingConfirmationV2: vi.fn(async () => null),
      appendCsvAttachmentV2: vi.fn(),
      setConversationInProgressPlanV2: vi.fn(),
      getConversationInProgressPlanV2: vi.fn(async () => null),
    },
    FakeConversationNotFoundV2Error,
  };
});
vi.mock("../lib/conversation-store-v2", () => ({
  ...v2Spies,
  ConversationNotFoundV2Error: FakeConversationNotFoundV2Error,
}));

// Stub cosmos + identity so the v1 module doesn't try to instantiate a
// real client at import time.
vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));
vi.mock("@azure/cosmos", () => {
  const v1Store = new Map<string, Map<string, Record<string, unknown>>>();
  function part(pk: string) {
    if (!v1Store.has(pk)) v1Store.set(pk, new Map());
    return v1Store.get(pk)!;
  }
  class FakeContainer {
    items = {
      async create<T extends { id: string; ownerId?: string }>(doc: T) {
        part(doc.ownerId ?? doc.id).set(doc.id, doc);
        return { resource: doc };
      },
      query<T>(_q: unknown) {
        return {
          async fetchAll(): Promise<{ resources: T[] }> {
            const all: T[] = [];
            for (const [, p] of v1Store) {
              for (const [, d] of p) all.push(d as unknown as T);
            }
            return { resources: all };
          },
        };
      },
    };
    item(id: string, pk: string) {
      return {
        async read<T>() {
          const doc = part(pk).get(id);
          return { resource: doc as unknown as T | undefined, etag: doc ? "e" : undefined };
        },
        async replace(doc: { id: string }) {
          part(pk).set(doc.id, doc);
          return { resource: doc };
        },
        async delete() {
          part(pk).delete(id);
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

import { setConversationInProgressPlan, createConversation } from "../lib/conversation-store";
import { __forceStoreModeForTest } from "../lib/conversation-store-mode";

const samplePlan: InProgressPlan = {
  schemaVersion: 1,
  createdAt: "2026-04-24T19:00:00.000Z",
  planText: "1. isolate alice\n2. isolate bob",
  toolCallsRemaining: 2,
  originalTurnNumber: 5,
};

describe("setConversationInProgressPlan dispatch", () => {
  beforeEach(() => {
    mockWarn.mockClear();
    mockEmitEvent.mockClear();
    Object.values(v2Spies).forEach((s) => s.mockClear());
  });

  it("v1 mode: writes through v1 only (v2 not touched)", async () => {
    const id = await __forceStoreModeForTest("v1", () =>
      createConversation("owner_1", "admin", "web"),
    );
    await __forceStoreModeForTest("v1", () =>
      setConversationInProgressPlan(id, "owner_1", samplePlan),
    );
    expect(v2Spies.setConversationInProgressPlanV2).not.toHaveBeenCalled();
  });

  it("v2 mode: writes through v2 only", async () => {
    await __forceStoreModeForTest("v2", () =>
      setConversationInProgressPlan("conv_v2", "owner_1", samplePlan),
    );
    expect(v2Spies.setConversationInProgressPlanV2).toHaveBeenCalledWith(
      "conv_v2",
      "owner_1",
      samplePlan,
    );
  });

  it("dual-write: writes to both; v2 failure emits divergence (not thrown)", async () => {
    const id = await __forceStoreModeForTest("v1", () =>
      createConversation("owner_1", "admin", "web"),
    );
    v2Spies.setConversationInProgressPlanV2.mockRejectedValueOnce(
      Object.assign(new Error("v2 down"), { code: 503 }),
    );
    await expect(
      __forceStoreModeForTest("dual-write", () =>
        setConversationInProgressPlan(id, "owner_1", samplePlan),
      ),
    ).resolves.not.toThrow();
    expect(v2Spies.setConversationInProgressPlanV2).toHaveBeenCalledTimes(1);
    expect(mockEmitEvent).toHaveBeenCalledWith(
      "conversation_dual_write_divergence",
      expect.any(String),
      "conversation-store",
      expect.objectContaining({ operation: "setInProgressPlan" }),
    );
  });

  it("dual-read: writes to v2; falls back to v1 on ConversationNotFoundV2Error", async () => {
    const id = await __forceStoreModeForTest("v1", () =>
      createConversation("owner_1", "admin", "web"),
    );
    v2Spies.setConversationInProgressPlanV2.mockRejectedValueOnce(
      new FakeConversationNotFoundV2Error(id),
    );
    await expect(
      __forceStoreModeForTest("dual-read", () =>
        setConversationInProgressPlan(id, "owner_1", samplePlan),
      ),
    ).resolves.not.toThrow();
    expect(v2Spies.setConversationInProgressPlanV2).toHaveBeenCalledTimes(1);
    // Fallback logged at info level on the dispatch helper — we can't
    // easily assert the info line, but the v1 write should land via
    // the fallback. Verify the v1 doc now has the plan.
    const { getConversation } = await import("../lib/conversation-store");
    const conv = await __forceStoreModeForTest("v1", () =>
      getConversation(id, "owner_1"),
    );
    expect(conv?.inProgressPlan).toEqual(samplePlan);
  });

  it("getConversationInProgressPlan returns null when the persisted shape fails validation", async () => {
    // Security-review S1: a Cosmos doc with a malformed inProgressPlan
    // (e.g., from a schema upgrade or direct DB tampering) MUST NOT
    // propagate an untrusted shape into the system-prompt resumption
    // hint. The read path validates via `isInProgressPlan` and
    // returns null for non-conforming data.
    const id = await __forceStoreModeForTest("v1", () =>
      createConversation("owner_1", "admin", "web"),
    );
    // Write a malformed plan directly to the fake Cosmos container,
    // bypassing `setConversationInProgressPlan` (which writes
    // well-formed shapes).
    const { getConversationInProgressPlan } = await import(
      "../lib/conversation-store"
    );
    const { CosmosClient } = await import("@azure/cosmos");
    const client = new CosmosClient({ endpoint: "https://x.documents.azure.com:443/" } as unknown as ConstructorParameters<typeof CosmosClient>[0]);
    const container = client
      .database("neo-db")
      .container("conversations");
    const { resource } = await container.item(id, "owner_1").read<{ inProgressPlan?: unknown; id: string }>();
    if (!resource) throw new Error("seed conversation missing");
    // Inject an adversarial shape — extra fields, wrong type, missing schemaVersion.
    (resource as { inProgressPlan: unknown }).inProgressPlan = {
      __proto__: { injected: true },
      planText: "not a real plan",
      // missing schemaVersion, toolCallsRemaining, createdAt, originalTurnNumber
    };
    await container.item(id, "owner_1").replace(resource);

    const got = await __forceStoreModeForTest("v1", () =>
      getConversationInProgressPlan(id, "owner_1"),
    );
    expect(got).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("failed shape validation"),
      "conversation-store",
      expect.objectContaining({ conversationId: id }),
    );
  });
});
