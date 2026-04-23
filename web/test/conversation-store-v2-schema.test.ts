import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config so the v2 adapter has a valid COSMOS_ENDPOINT target
// and deterministic defaults without real env vars.
vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/" },
  NEO_CONVERSATIONS_V2_CONTAINER: "neo-conversations-v2",
  NEO_RETENTION_CLASS_DEFAULT: "standard-7y",
}));

// Silence the logger.
const { mockInfo } = vi.hoisted(() => ({ mockInfo: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: {
    info: mockInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

// Stub the blob-store helpers — v2 calls promoteStagingBlob from
// appendMessagesV2; we just want to verify it's called at the right
// time, not that the real blob path works (phase 3's tests cover that).
const { mockPromoteStagingBlob } = vi.hoisted(() => ({
  mockPromoteStagingBlob: vi.fn(async (_sha: string) => {}),
}));
vi.mock("../lib/tool-result-blob-store", () => ({
  promoteStagingBlob: mockPromoteStagingBlob,
  isBlobRefDescriptor: (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    return (v as { _neo_blob_ref?: unknown })._neo_blob_ref === true;
  },
}));

// ─── Fake Cosmos container ──────────────────────────────────
//
// Minimal in-memory store that mirrors the tiny subset of the Cosmos
// Container API we exercise: items.create, item(id, pk).read/patch,
// items.batch, items.query(...).fetchAll(). Docs are keyed by
// (partitionKey, id). Read returns the stored doc + a synthetic etag;
// patch mutates in place; batch commits a list of ops atomically.
//
// Only the partition-keyed operations are needed for the v2 adapter.

interface FakeDoc {
  [key: string]: unknown;
  id: string;
  conversationId: string;
}

function makeFakeContainer() {
  const store = new Map<string, Map<string, FakeDoc>>(); // partitionKey → id → doc

  function partition(pk: string): Map<string, FakeDoc> {
    if (!store.has(pk)) store.set(pk, new Map());
    return store.get(pk)!;
  }

  // Typed loosely so tests can spy on individual methods. The SUT
  // imports via the `Container` type from @azure/cosmos but we cast
  // at the __resetV2ContainerForTest boundary.
  interface FakeBatchOp {
    operationType: "Create" | "Patch" | "Delete";
    id?: string;
    resourceBody?: unknown;
    ifMatch?: string;
  }
  interface FakeContainer {
    items: {
      create<T extends FakeDoc>(doc: T): Promise<{ resource: T }>;
      query<T>(
        q: { query: string; parameters?: Array<{ name: string; value: string }> },
      ): { fetchAll(): Promise<{ resources: T[] }> };
      batch(
        operations: FakeBatchOp[],
        partitionKey: string,
      ): Promise<{ code: number }>;
    };
    item(id: string, partitionKey: string): {
      read<T>(): Promise<{ resource: T | undefined; etag: string | undefined }>;
      patch(
        body: { operations: Array<{ op: string; path: string; value: unknown }> },
        options?: unknown,
      ): Promise<{ resource: FakeDoc }>;
      replace(doc: FakeDoc, opts?: unknown): Promise<{ resource: FakeDoc }>;
      delete(): Promise<{ code: number }>;
    };
  }
  const container: FakeContainer = {
    items: {
      async create<T extends FakeDoc>(doc: T): Promise<{ resource: T }> {
        const pk = doc.conversationId ?? doc.id;
        partition(pk).set(doc.id, doc);
        return { resource: doc };
      },
      query<T>({ query, parameters }: { query: string; parameters?: Array<{ name: string; value: string }> }) {
        // Sufficient for the v2 adapter's queries:
        //   "SELECT * FROM c WHERE c.conversationId = @id AND c.docType = 'turn' ORDER BY c.turnNumber ASC"
        //   "SELECT c.id FROM c WHERE c.conversationId = @id"
        //   "SELECT ... FROM c WHERE c.docType = 'root' AND c.ownerId = @ownerId [AND c.channel ...] ORDER BY c.updatedAt DESC"
        // We parse the intent loosely rather than implement SQL.
        const params = Object.fromEntries(
          (parameters ?? []).map((p) => [p.name, p.value]),
        );
        const allDocs: FakeDoc[] = [];
        for (const [, p] of store) {
          for (const [, d] of p) allDocs.push(d);
        }

        let filtered = allDocs;
        if (query.includes("c.conversationId = @id")) {
          filtered = filtered.filter((d) => d.conversationId === params["@id"]);
        }
        if (query.includes('c.docType = "turn"')) {
          filtered = filtered.filter((d) => d.docType === "turn");
        }
        if (query.includes('c.docType = "root"')) {
          filtered = filtered.filter((d) => d.docType === "root");
        }
        if (query.includes("c.ownerId = @ownerId")) {
          filtered = filtered.filter((d) => d.ownerId === params["@ownerId"]);
        }
        if (query.includes("c.channel = @channel")) {
          filtered = filtered.filter((d) => d.channel === params["@channel"]);
        }
        if (query.includes("c.turnNumber ASC")) {
          filtered = filtered.sort(
            (a, b) => (a.turnNumber as number) - (b.turnNumber as number),
          );
        }
        if (query.includes("c.updatedAt DESC")) {
          filtered = filtered.sort((a, b) =>
            String(b.updatedAt).localeCompare(String(a.updatedAt)),
          );
        }

        return {
          async fetchAll() {
            return { resources: filtered as unknown as T[] };
          },
        };
      },
      async batch(
        operations: Array<{
          operationType: "Create" | "Patch" | "Delete";
          id?: string;
          resourceBody?: Record<string, unknown> | { operations: unknown[] };
          ifMatch?: string;
        }>,
        partitionKey: string,
      ) {
        // Apply each op in order. We don't simulate partial-success
        // semantics — Cosmos returns success or failure atomically and
        // our tests don't exercise mid-batch failures.
        for (const op of operations) {
          if (op.operationType === "Create") {
            const doc = op.resourceBody as FakeDoc;
            partition(partitionKey).set(doc.id, doc);
          } else if (op.operationType === "Patch") {
            const existing = partition(partitionKey).get(op.id!);
            if (!existing) return { code: 404 };
            const patchOps =
              (op.resourceBody as { operations: Array<{ op: string; path: string; value: unknown }> })
                .operations ?? [];
            for (const p of patchOps) {
              if (p.op === "set") {
                const field = p.path.replace(/^\//, "");
                existing[field] = p.value;
              }
            }
          } else if (op.operationType === "Delete") {
            partition(partitionKey).delete(op.id!);
          }
        }
        return { code: 200 };
      },
    },
    item(id: string, partitionKey: string) {
      return {
        async read<T>(): Promise<{ resource: T | undefined; etag: string | undefined }> {
          const doc = partition(partitionKey).get(id);
          return { resource: doc as unknown as T | undefined, etag: doc ? "fake-etag" : undefined };
        },
        async patch(
          body: { operations: Array<{ op: string; path: string; value: unknown }> },
          _options?: unknown,
        ) {
          const existing = partition(partitionKey).get(id);
          if (!existing) throw Object.assign(new Error("not found"), { code: 404 });
          for (const p of body.operations) {
            if (p.op === "set") {
              const field = p.path.replace(/^\//, "");
              existing[field] = p.value;
            }
          }
          return { resource: existing };
        },
        async replace(doc: FakeDoc, _opts?: unknown) {
          partition(partitionKey).set(doc.id, doc);
          return { resource: doc };
        },
        async delete() {
          partition(partitionKey).delete(id);
          return { code: 204 };
        },
      };
    },
  };

  return { container, store };
}

// Mock @azure/cosmos + @azure/identity so CosmosClient instantiation
// doesn't touch the network. We inject our own fake container via the
// __resetV2ContainerForTest escape hatch.
vi.mock("@azure/cosmos", () => {
  return {
    CosmosClient: class {
      constructor(_opts: unknown) {}
      database(_name: string) {
        return { container: (_c: string) => ({}) };
      }
    },
  };
});
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {},
}));

import {
  createConversationV2,
  getConversationV2,
  listConversationsV2,
  appendMessagesV2,
  updateTitleV2,
  deleteConversationV2,
  setConversationPendingConfirmationV2,
  clearConversationPendingConfirmationV2,
  appendCsvAttachmentV2,
  getCsvAttachmentsV2,
  isConversationRateLimitedV2,
  splitConversationToDocs,
  rebuildConversationFromDocs,
  __resetV2ContainerForTest,
  CosmosV2SessionStore,
} from "../lib/conversation-store-v2";
import type { Conversation, ConversationV2Root, TurnDoc } from "../lib/types";
import { CsvAttachmentCapError } from "../lib/types";

describe("v2 schema transforms", () => {
  describe("splitConversationToDocs", () => {
    it("produces a root with docType 'root' + turnCount + schemaVersion: 2", () => {
      const conv: Conversation = {
        id: "conv_abc",
        ownerId: "owner_1",
        title: "Hello",
        createdAt: "2026-04-21T10:00:00.000Z",
        updatedAt: "2026-04-21T10:05:00.000Z",
        messageCount: 2,
        role: "reader",
        channel: "web",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hey" },
        ],
        pendingConfirmation: null,
      };
      const { root, turns, blobRefs, checkpoints } = splitConversationToDocs(conv);
      expect(root.docType).toBe("root");
      expect(root.schemaVersion).toBe(2);
      expect(root.turnCount).toBe(2);
      expect(root.id).toBe("conv_abc");
      expect(root.conversationId).toBe("conv_abc");
      expect(turns).toHaveLength(2);
      expect(turns[0].turnNumber).toBe(1);
      expect(turns[0].id).toBe("turn_conv_abc_1");
      expect(turns[0].parentTurnId).toBeNull();
      expect(turns[1].parentTurnId).toBe("turn_conv_abc_1");
      expect(blobRefs).toHaveLength(0); // pure transform doesn't offload
      expect(checkpoints).toHaveLength(0);
    });

    it("preserves tool_result content byte-for-byte (descriptors pass through)", () => {
      const descriptorJson = JSON.stringify({
        _neo_blob_ref: true,
        sha256: "abc",
        uri: "https://mock/...",
        sizeBytes: 1000,
        mediaType: "application/json",
        shortSummary: "",
        sourceTool: "t",
      });
      const conv: Conversation = {
        id: "c",
        ownerId: "o",
        title: null,
        createdAt: "2026-04-21T10:00:00.000Z",
        updatedAt: "2026-04-21T10:05:00.000Z",
        messageCount: 1,
        role: "reader",
        channel: "web",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: descriptorJson },
            ],
          },
        ],
        pendingConfirmation: null,
      };
      const { turns } = splitConversationToDocs(conv);
      expect(turns[0].content).toEqual([
        { type: "tool_result", tool_use_id: "tu_1", content: descriptorJson },
      ]);
    });
  });

  describe("rebuildConversationFromDocs", () => {
    it("sorts turns by turnNumber and reconstructs Conversation shape", () => {
      const root: ConversationV2Root = {
        id: "c",
        docType: "root",
        conversationId: "c",
        ownerId: "o",
        title: "t",
        createdAt: "2026-04-21T10:00:00.000Z",
        updatedAt: "2026-04-21T10:05:00.000Z",
        role: "reader",
        channel: "web",
        schemaVersion: 2,
        retentionClass: "standard-7y",
        turnCount: 3,
        latestCheckpointId: null,
        rollingSummary: null,
        pendingConfirmation: null,
      };
      // Insert out of order to ensure the rebuilder sorts.
      const turns: TurnDoc[] = [
        {
          id: "turn_c_2",
          docType: "turn",
          conversationId: "c",
          turnNumber: 2,
          role: "assistant",
          content: "reply1",
          parentTurnId: "turn_c_1",
          inputTokens: 0,
          outputTokens: 0,
          createdAt: "2026-04-21T10:01:00.000Z",
        },
        {
          id: "turn_c_1",
          docType: "turn",
          conversationId: "c",
          turnNumber: 1,
          role: "user",
          content: "q1",
          parentTurnId: null,
          inputTokens: 0,
          outputTokens: 0,
          createdAt: "2026-04-21T10:00:00.000Z",
        },
        {
          id: "turn_c_3",
          docType: "turn",
          conversationId: "c",
          turnNumber: 3,
          role: "user",
          content: "q2",
          parentTurnId: "turn_c_2",
          inputTokens: 0,
          outputTokens: 0,
          createdAt: "2026-04-21T10:02:00.000Z",
        },
      ];
      const conv = rebuildConversationFromDocs({ root, turns });
      expect(conv.messages.map((m) => m.content)).toEqual(["q1", "reply1", "q2"]);
      expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(conv.messageCount).toBe(3);
      expect(conv.id).toBe("c");
    });
  });
});

describe("v2 CRUD", () => {
  let fake: ReturnType<typeof makeFakeContainer>;

  beforeEach(() => {
    fake = makeFakeContainer();
    __resetV2ContainerForTest(fake.container as never);
    mockPromoteStagingBlob.mockReset();
  });

  it("createConversationV2 inserts a root doc with docType 'root' and schemaVersion: 2", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    expect(id).toMatch(/^conv_/);
    const stored = fake.store.get(id)!.get(id)!;
    expect(stored.docType).toBe("root");
    expect(stored.schemaVersion).toBe(2);
    expect(stored.turnCount).toBe(0);
    expect(stored.ownerId).toBe("owner_1");
  });

  it("appendMessagesV2 appends turn docs + patches root turnCount (no full-replace)", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    await appendMessagesV2(id, "owner_1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    const partition = fake.store.get(id)!;
    const root = partition.get(id)!;
    expect(root.turnCount).toBe(2);
    expect(root.docType).toBe("root"); // still root — not replaced
    const turn1 = partition.get(`turn_${id}_1`)!;
    expect(turn1.docType).toBe("turn");
    expect(turn1.role).toBe("user");
    expect(turn1.content).toBe("hello");
    expect(turn1.turnNumber).toBe(1);
    const turn2 = partition.get(`turn_${id}_2`)!;
    expect(turn2.turnNumber).toBe(2);
    expect(turn2.parentTurnId).toBe(`turn_${id}_1`);
  });

  it("appendMessagesV2 starts subsequent appends after the existing turnCount", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    await appendMessagesV2(id, "owner_1", [{ role: "user", content: "q1" }]);
    await appendMessagesV2(id, "owner_1", [{ role: "assistant", content: "a1" }]);
    const partition = fake.store.get(id)!;
    expect(partition.get(id)!.turnCount).toBe(2);
    expect(partition.get(`turn_${id}_2`)!.content).toBe("a1");
  });

  it("appendMessagesV2 promotes staging blobs for any trust-marked offloaded tool_result descriptors", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    const sha = "a".repeat(64);
    const descriptor = {
      _neo_blob_ref: true,
      sha256: sha,
      uri: "https://mock/...",
      sizeBytes: 1,
      mediaType: "application/json",
      rawPrefix: "",
      sourceTool: "t",
      conversationId: id,
    };
    // Injection-guard-style envelope — includes _neo_trust_boundary to
    // signal this was produced by our own offload path.
    const envelope = {
      _neo_trust_boundary: { source: "tool_offload", tool: "t" },
      data: descriptor,
    };
    await appendMessagesV2(id, "owner_1", [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: JSON.stringify(envelope),
          },
        ],
      },
    ]);
    expect(mockPromoteStagingBlob).toHaveBeenCalledWith(sha);
  });

  it("appendMessagesV2 does NOT promote a descriptor from an envelope without _neo_trust_boundary", async () => {
    // A doctored Cosmos write that wraps `{ data: <descriptor> }`
    // without the trust marker must NOT trigger promotion.
    const id = await createConversationV2("owner_1", "reader", "web");
    const sha = "b".repeat(64);
    const descriptor = {
      _neo_blob_ref: true,
      sha256: sha,
      uri: "https://mock/...",
      sizeBytes: 1,
      mediaType: "application/json",
      rawPrefix: "",
      sourceTool: "t",
      conversationId: id,
    };
    await appendMessagesV2(id, "owner_1", [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            // Envelope-shaped but missing _neo_trust_boundary → reject.
            content: JSON.stringify({ data: descriptor }),
          },
        ],
      },
    ]);
    expect(mockPromoteStagingBlob).not.toHaveBeenCalled();
  });

  it("updateTitleV2 patches the root (not replace)", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    await updateTitleV2(id, "owner_1", "New Title");
    const root = fake.store.get(id)!.get(id)!;
    expect(root.title).toBe("New Title");
    expect(root.docType).toBe("root"); // not accidentally overwritten
  });

  it("setConversationPendingConfirmationV2 patches the root; clearConversationPendingConfirmationV2 returns the old value", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    const tool = {
      id: "tu_1",
      name: "reset_user_password",
      input: { upn: "x@y.com" },
    };
    await setConversationPendingConfirmationV2(id, "owner_1", tool);
    expect(fake.store.get(id)!.get(id)!.pendingConfirmation).toEqual(tool);

    const cleared = await clearConversationPendingConfirmationV2(id, "owner_1");
    expect(cleared).toEqual(tool);
    expect(fake.store.get(id)!.get(id)!.pendingConfirmation).toBeNull();
  });

  it("getConversationV2 reassembles Conversation shape with sorted turns + owner check", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    await appendMessagesV2(id, "owner_1", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);

    const conv = await getConversationV2(id, "owner_1");
    expect(conv).not.toBeNull();
    expect(conv!.messageCount).toBe(3);
    expect(conv!.messages.map((m) => m.content)).toEqual(["q1", "a1", "q2"]);

    // Owner mismatch returns null (admin cross-owner happens at the route level).
    const notMine = await getConversationV2(id, "owner_2");
    expect(notMine).toBeNull();
  });

  it("deleteConversationV2 removes root + all turn docs in the partition", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    await appendMessagesV2(id, "owner_1", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(fake.store.get(id)!.size).toBe(3); // root + 2 turns
    await deleteConversationV2(id, "owner_1");
    // Partition is either empty or fully cleared.
    expect(fake.store.get(id)?.size ?? 0).toBe(0);
  });

  it("listConversationsV2 returns root docs owned by the caller ordered newest-first", async () => {
    // Use fake timers so timestamps differ deterministically without
    // relying on real wall-clock resolution.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    const a = await createConversationV2("owner_1", "reader", "web");
    vi.setSystemTime(new Date("2026-04-21T10:00:05.000Z"));
    const b = await createConversationV2("owner_1", "reader", "web");
    vi.setSystemTime(new Date("2026-04-21T10:00:10.000Z"));
    await createConversationV2("owner_2", "reader", "web"); // should not appear
    vi.useRealTimers();

    // Seed some turns to make sure they're excluded from listing.
    await appendMessagesV2(a, "owner_1", [{ role: "user", content: "q" }]);

    const out = await listConversationsV2("owner_1");
    const ids = out.map((c) => c.id);
    // Ownership filter: owner_2's doc should NOT appear.
    expect(out.every((c) => c.ownerId === "owner_1")).toBe(true);
    // Ordering: b was created AFTER a (newer), so despite the later
    // appendMessages on a updating its updatedAt, the final list is
    // ordered by root.updatedAt — the appendMessages bumped a to
    // "now" (real time) which is after b's fake-time createdAt, so
    // a should be first.
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
  });

  it("appendCsvAttachmentV2 adds to root.csvAttachments on the happy path", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    const attach = {
      csvId: "csv_1",
      filename: "x.csv",
      blobUrl: "https://mock/x.csv",
      rowCount: 10,
      columns: ["a", "b"],
      sampleRows: [["1", "2"]],
      createdAt: "2026-04-21T10:00:00.000Z",
    };
    await appendCsvAttachmentV2(id, "owner_1", attach);
    const csvs = await getCsvAttachmentsV2(id, "owner_1");
    expect(csvs).toHaveLength(1);
    expect(csvs[0].csvId).toBe("csv_1");
  });

  it("appendCsvAttachmentV2 throws CsvAttachmentCapError when at the cap (10)", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    const baseAttach = {
      filename: "x.csv",
      blobUrl: "https://mock/x.csv",
      rowCount: 10,
      columns: ["a", "b"],
      sampleRows: [["1", "2"]],
      createdAt: "2026-04-21T10:00:00.000Z",
    };
    for (let i = 0; i < 10; i++) {
      await appendCsvAttachmentV2(id, "owner_1", { ...baseAttach, csvId: `csv_${i}` });
    }
    await expect(
      appendCsvAttachmentV2(id, "owner_1", { ...baseAttach, csvId: "csv_10" }),
    ).rejects.toThrow(CsvAttachmentCapError);
    // The cap prevents any addition beyond 10.
    const csvs = await getCsvAttachmentsV2(id, "owner_1");
    expect(csvs).toHaveLength(10);
  });

  it("isConversationRateLimitedV2 returns false for a brand-new conversation", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    const before = await isConversationRateLimitedV2(id, "owner_1");
    expect(before).toBe(false);
  });

  it("isConversationRateLimitedV2 returns true when turnCount reaches the role cap", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    // Patch the root directly to simulate hitting the cap without
    // actually creating N turn docs. Reader cap is 100 messages.
    await fake.container.item(id, id).patch({
      operations: [{ op: "set", path: "/turnCount", value: 100 }],
    });
    expect(await isConversationRateLimitedV2(id, "owner_1")).toBe(true);
  });

  it("appendMessagesV2 retries once on 412 etag conflict (single-batch path)", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    let callCount = 0;
    const origBatch = fake.container.items.batch.bind(fake.container.items);
    const spy = vi
      .spyOn(fake.container.items, "batch")
      .mockImplementation(async (...args) => {
        if (callCount++ === 0) return { code: 412 };
        return origBatch(...args);
      });
    await expect(
      appendMessagesV2(id, "owner_1", [{ role: "user", content: "q" }]),
    ).resolves.not.toThrow();
    expect(callCount).toBe(2);
    expect(fake.store.get(id)!.get(id)!.turnCount).toBe(1);
    spy.mockRestore();
  });

  it("appendMessagesV2 throws a descriptive error on multi-chunk 412 (>99 messages)", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    // Force a 412 on the first batch call.
    const spy = vi
      .spyOn(fake.container.items, "batch")
      .mockImplementation(async () => ({ code: 412 }));
    const bulk = Array.from({ length: 150 }, (_, i) => ({
      role: "user" as const,
      content: `q${i}`,
    }));
    await expect(
      appendMessagesV2(id, "owner_1", bulk),
    ).rejects.toThrow(/multi-chunk append/);
    spy.mockRestore();
  });

  it("appendMessagesV2 retries once on 409 turn-id conflict (concurrent same-session appender race)", async () => {
    // Reviewer bug_015: two concurrent appenders compute the same
    // deterministic turn id `turn_<conv>_<N+1>`. The batch is
    // Create-first / Patch-last, so Cosmos surfaces the Create
    // collision as a 409 *before* the Patch ifMatch fires. The retry
    // path must handle 409 identically to 412.
    const id = await createConversationV2("owner_1", "reader", "web");
    let callCount = 0;
    const origBatch = fake.container.items.batch.bind(fake.container.items);
    const spy = vi
      .spyOn(fake.container.items, "batch")
      .mockImplementation(async (...args) => {
        if (callCount++ === 0) return { code: 409 };
        return origBatch(...args);
      });
    await expect(
      appendMessagesV2(id, "owner_1", [{ role: "user", content: "q" }]),
    ).resolves.not.toThrow();
    expect(callCount).toBe(2);
    expect(fake.store.get(id)!.get(id)!.turnCount).toBe(1);
    spy.mockRestore();
  });
});

describe("CosmosV2SessionStore.saveMessages — delta append semantics", () => {
  let fake: ReturnType<typeof makeFakeContainer>;
  let store: CosmosV2SessionStore;

  beforeEach(() => {
    fake = makeFakeContainer();
    __resetV2ContainerForTest(fake.container as never);
    store = new CosmosV2SessionStore();
  });

  it("only appends the delta beyond the current turnCount", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    // Seed two turns.
    await appendMessagesV2(id, "owner_1", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    // saveMessages is called by stream.ts with the cumulative array —
    // the store must recognise that only message index 2+ is new.
    await store.saveMessages(id, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    const partition = fake.store.get(id)!;
    expect(partition.get(id)!.turnCount).toBe(3);
    expect(partition.get(`turn_${id}_3`)!.content).toBe("q2");
    // No duplicate of q1 / a1.
    expect(partition.get(`turn_${id}_4`)).toBeUndefined();
  });

  it("zero delta is a no-op (just touches updatedAt)", async () => {
    const id = await createConversationV2("owner_1", "reader", "web");
    await appendMessagesV2(id, "owner_1", [{ role: "user", content: "q1" }]);
    const root = fake.store.get(id)!.get(id)!;
    const beforeUpdatedAt = root.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await store.saveMessages(id, [{ role: "user", content: "q1" }]);
    const after = fake.store.get(id)!.get(id)!;
    expect(after.turnCount).toBe(1);
    expect(after.updatedAt).not.toBe(beforeUpdatedAt);
  });

  it("throws a 409 conflict when the persisted turnCount is ahead of the caller's messages (concurrent-write detection)", async () => {
    // Reviewer bug_010: prior behavior was slice(currentTurnCount) →
    // [] for any case where persisted > caller, and the zero-delta
    // branch silently dropped the caller's new turn. Double-clicked
    // Send / two-tab / cross-pod races now surface as a retryable
    // 409 instead of a silent data loss.
    const id = await createConversationV2("owner_1", "reader", "web");
    // Pod A wrote m1 + m2; persisted turnCount is now 2.
    await appendMessagesV2(id, "owner_1", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    // Pod B loaded the session WHEN turnCount was still 1, produced
    // its own m2_B, and calls saveMessages with cumulative [q1, m2_B].
    // Detection: caller.length (2) is NOT greater than persisted (2),
    // but the caller's turn 2 was intended to be "m2_B" not "a1" —
    // the delta check (currentTurnCount > messages.length) correctly
    // fires only when someone wrote MORE than the caller has. Here
    // we force that by seeding a 3rd turn before Pod B's save.
    await appendMessagesV2(id, "owner_1", [{ role: "user", content: "q2" }]);
    expect(fake.store.get(id)!.get(id)!.turnCount).toBe(3);

    // Pod B only has 2 in hand. Silent drop would be a bug; the store
    // must surface a conflict.
    await expect(
      store.saveMessages(id, [
        { role: "user", content: "q1" },
        { role: "assistant", content: "m2_B" },
      ]),
    ).rejects.toMatchObject({ code: 409 });
  });

  it("throws ConversationNotFoundV2Error on missing root (distinct from zero-delta no-op)", async () => {
    // Reviewer merged_bug_001: prior behavior was silent return when
    // the root didn't exist — the session-factory dispatcher depends
    // on this error now to fall back to v1 under dual-read.
    await expect(
      store.saveMessages("conv_nonexistent-1111-4111-8111-111111111111", [
        { role: "user", content: "q1" },
      ]),
    ).rejects.toThrow(/not found \(v2\)/);
  });
});
