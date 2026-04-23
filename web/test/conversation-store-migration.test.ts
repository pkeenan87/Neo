import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/" },
  NEO_CONVERSATIONS_V2_CONTAINER: "neo-conversations-v2",
  NEO_RETENTION_CLASS_DEFAULT: "standard-7y",
  NEO_BLOB_OFFLOAD_THRESHOLD_BYTES: 1024,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

// Don't care about the real blob-store wiring — tests inject offload /
// promote / resolve stubs via the MigrationIO. But a few helpers (
// isBlobRefDescriptor) are imported statically by the migration
// module, so stub them too.
vi.mock("../lib/tool-result-blob-store", () => ({
  isBlobRefDescriptor: (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    return (v as { _neo_blob_ref?: unknown })._neo_blob_ref === true;
  },
  maybeOffloadToolResult: vi.fn(),
  promoteStagingBlob: vi.fn(),
  resolveBlobRef: vi.fn(),
}));

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(_o: unknown) {}
    database(_n: string) {
      return { container: (_c: string) => ({}) };
    }
  },
}));
vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));

// ─── Fake container ─────────────────────────────────────────

interface FakeDoc {
  [k: string]: unknown;
  id: string;
  ownerId?: string;
  conversationId?: string;
  docType?: string;
}

function makeFakeContainer() {
  const byPartition = new Map<string, Map<string, FakeDoc>>();
  function part(pk: string) {
    if (!byPartition.has(pk)) byPartition.set(pk, new Map());
    return byPartition.get(pk)!;
  }
  function partReadOnly(pk: string) {
    return byPartition.get(pk);
  }
  return {
    _store: byPartition,
    items: {
      async create<T extends FakeDoc>(doc: T): Promise<{ resource: T }> {
        // v1 docs partition on ownerId; v2 partition on conversationId
        // (or id for root). The fake keys on whichever field is set.
        const pk = doc.conversationId ?? doc.ownerId ?? doc.id;
        part(pk).set(doc.id, doc);
        return { resource: doc };
      },
      query<T>({
        query,
        parameters,
      }: {
        query: string;
        parameters?: Array<{ name: string; value: string }>;
      }) {
        const params = Object.fromEntries(
          (parameters ?? []).map((p) => [p.name, p.value]),
        );
        const all: FakeDoc[] = [];
        for (const [, inner] of byPartition) {
          for (const [, d] of inner) all.push(d);
        }
        let filtered = all;
        if (query.includes('c.docType = "root"')) {
          filtered = filtered.filter((d) => d.docType === "root");
        }
        if (query.includes('c.docType = "turn"')) {
          filtered = filtered.filter((d) => d.docType === "turn");
        }
        if (query.includes("c.conversationId = @id")) {
          filtered = filtered.filter((d) => d.conversationId === params["@id"]);
        }
        if (query.includes("c.ownerId = @ownerId")) {
          filtered = filtered.filter((d) => d.ownerId === params["@ownerId"]);
        }
        if (query.includes("c.id = @convId")) {
          filtered = filtered.filter((d) => d.id === params["@convId"]);
        }
        if (query.includes("c.id > @afterId")) {
          filtered = filtered.filter(
            (d) => (d.id as string) > (params["@afterId"] ?? ""),
          );
        }
        if (query.includes("c.updatedAt >= @since")) {
          filtered = filtered.filter(
            (d) => String(d.updatedAt) >= String(params["@since"]),
          );
        }
        if (query.includes("c.turnNumber ASC")) {
          filtered = filtered.sort(
            (a, b) => (a.turnNumber as number) - (b.turnNumber as number),
          );
        }
        if (query.includes("c.id ASC")) {
          filtered = filtered.sort((a, b) =>
            String(a.id).localeCompare(String(b.id)),
          );
        }
        let delivered = false;
        return {
          hasMoreResults: () => !delivered,
          async fetchNext() {
            delivered = true;
            return { resources: filtered as unknown as T[] };
          },
          async fetchAll() {
            return { resources: filtered as unknown as T[] };
          },
        };
      },
      async batch(
        operations: Array<{
          operationType: "Create" | "Patch" | "Delete";
          id?: string;
          resourceBody?: unknown;
        }>,
        partitionKey: string,
      ) {
        for (const op of operations) {
          if (op.operationType === "Create") {
            const doc = op.resourceBody as FakeDoc;
            part(partitionKey).set(doc.id, doc);
          }
        }
        return { code: 200 };
      },
    },
    item(id: string, partitionKey: string) {
      return {
        async read<T>() {
          const doc = partReadOnly(partitionKey)?.get(id);
          if (!doc) {
            const err: Error & { code: number } = Object.assign(
              new Error("not found"),
              { code: 404 },
            );
            throw err;
          }
          return { resource: doc as unknown as T, etag: "fake-etag" };
        },
        async patch(body: {
          operations: Array<{ op: string; path: string; value: unknown }>;
        }) {
          const doc = partReadOnly(partitionKey)?.get(id);
          if (!doc) {
            const err: Error & { code: number } = Object.assign(
              new Error("not found"),
              { code: 404 },
            );
            throw err;
          }
          for (const p of body.operations) {
            if (p.op === "set") {
              const field = p.path.replace(/^\//, "");
              doc[field] = p.value;
            }
          }
          return { resource: doc };
        },
      };
    },
  };
}

import {
  parseMigrateArgs,
  runMigration,
  migrateOneConversationV1ToV2,
  splitV1ToV2WithOffload,
  rebuildV2ToV1WithInlining,
  V1_MAX_DOC_BYTES,
} from "../lib/migrate-conversations";
import type { Conversation, ConversationV2Root, TurnDoc } from "../lib/types";

// ─── Tests ──────────────────────────────────────────────────

describe("parseMigrateArgs", () => {
  it("defaults to v1-to-v2, dry-run off", () => {
    expect(parseMigrateArgs([])).toEqual({
      dryRun: false,
      direction: "v1-to-v2",
    });
  });

  it("parses --dry-run and scalar flags", () => {
    const opts = parseMigrateArgs([
      "--dry-run",
      "--since",
      "2026-01-01",
      "--conversation-id",
      "conv_abc",
      "--owner-id",
      "user_1",
      "--ru-budget",
      "500",
      "--force-rerun",
    ]);
    expect(opts).toEqual({
      dryRun: true,
      direction: "v1-to-v2",
      since: "2026-01-01",
      conversationId: "conv_abc",
      ownerId: "user_1",
      ruBudget: 500,
      forceRerun: true,
    });
  });

  it("rejects unknown direction", () => {
    expect(() => parseMigrateArgs(["--direction", "sideways"])).toThrow(
      /--direction must be/,
    );
  });

  it("rejects unknown flag", () => {
    expect(() => parseMigrateArgs(["--nope"])).toThrow(/Unknown flag/);
  });
});

describe("splitV1ToV2WithOffload", () => {
  it("offloads oversized tool_result inner content and synthesizes BlobRefDocs", async () => {
    const bigPayload = "x".repeat(4096);
    const conv: Conversation = {
      id: "conv_11111111-1111-4111-8111-111111111111",
      ownerId: "user_1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
      role: "reader",
      channel: "web",
      pendingConfirmation: null,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_123", content: bigPayload },
          ],
        },
      ],
    };

    const offloadCalls: Array<{ ctx: unknown }> = [];
    const offloadToolResult = vi.fn(async (_json: string, ctx: unknown) => {
      offloadCalls.push({ ctx });
      return {
        _neo_blob_ref: true as const,
        sha256: "deadbeef",
        sizeBytes: bigPayload.length,
        mediaType: "application/json",
        rawPrefix: "xxxxx",
        uri: "https://blob/staging/deadbeef",
        sourceTool: "tool_use_tu_123",
        conversationId: conv.id,
      };
    });

    const result = await splitV1ToV2WithOffload(conv, { offloadToolResult });

    expect(offloadCalls).toHaveLength(1);
    expect(result.shasToPromote).toEqual(["deadbeef"]);
    expect(result.blobRefs).toHaveLength(1);
    expect(result.blobRefs[0]).toMatchObject({
      docType: "blobref",
      sha256: "deadbeef",
      conversationId: conv.id,
    });

    // Inner content of the tool_result block is now the SAME trust-marked
    // envelope string the runtime path produces — NOT a raw descriptor
    // object. See ultrareview merged_bug_003.
    const turn = result.turns[0];
    const block = (turn.content as Array<Record<string, unknown>>)[0];
    expect(typeof block.content).toBe("string");
    const envelope = JSON.parse(block.content as string);
    expect(envelope._neo_trust_boundary).toMatchObject({ source: "tool_offload" });
    expect(envelope.data._neo_blob_ref).toBe(true);
    expect(envelope.data.sha256).toBe("deadbeef");
  });

  it("leaves small tool results inline", async () => {
    const small = "small payload";
    const conv: Conversation = {
      id: "conv_22222222-2222-4222-8222-222222222222",
      ownerId: "user_1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
      role: "reader",
      channel: "web",
      pendingConfirmation: null,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_small", content: small }],
        },
      ],
    };
    const offloadToolResult = vi.fn();
    const result = await splitV1ToV2WithOffload(conv, { offloadToolResult });
    expect(offloadToolResult).not.toHaveBeenCalled();
    expect(result.blobRefs).toEqual([]);
    expect(result.shasToPromote).toEqual([]);
  });

  it("skips already-offloaded tool_result blocks (idempotent re-migrate)", async () => {
    const conv: Conversation = {
      id: "conv_33333333-3333-4333-8333-333333333333",
      ownerId: "user_1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
      role: "reader",
      channel: "web",
      pendingConfirmation: null,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_already",
              content: {
                _neo_blob_ref: true,
                sha256: "abc",
                sizeBytes: 9999,
                mediaType: "application/json",
                rawPrefix: "",
                uri: "https://blob/blobs/abc",
                sourceTool: "t",
                conversationId: "conv_33333333-3333-4333-8333-333333333333",
              },
            },
          ] as unknown as Conversation["messages"][number]["content"],
        },
      ],
    };
    const offloadToolResult = vi.fn();
    const result = await splitV1ToV2WithOffload(conv, { offloadToolResult });
    expect(offloadToolResult).not.toHaveBeenCalled();
    expect(result.blobRefs).toEqual([]);
  });

  it("skips tool_result blocks already carrying a trust-marked envelope string (idempotent re-migrate of a previously-migrated doc)", async () => {
    // Reviewer merged_bug_003 follow-up: once splitV1ToV2WithOffload
    // emits envelope strings, a re-migration of an already-migrated
    // v1 doc (theoretically reverse-migrated then re-migrated) must
    // not re-offload. The idempotency check unwraps envelopes.
    const envelope = JSON.stringify({
      _neo_trust_boundary: { source: "tool_offload", tool: "t", injection_detected: false },
      data: {
        _neo_blob_ref: true,
        sha256: "already",
        sizeBytes: 9999,
        mediaType: "application/json",
        rawPrefix: "",
        uri: "https://blob/blobs/already",
        sourceTool: "t",
        conversationId: "conv_77777777-7777-4777-8777-777777777777",
      },
    });
    const conv: Conversation = {
      id: "conv_77777777-7777-4777-8777-777777777777",
      ownerId: "user_1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
      role: "reader",
      channel: "web",
      pendingConfirmation: null,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_env", content: envelope },
          ] as unknown as Conversation["messages"][number]["content"],
        },
      ],
    };
    const offloadToolResult = vi.fn();
    const result = await splitV1ToV2WithOffload(conv, { offloadToolResult });
    expect(offloadToolResult).not.toHaveBeenCalled();
    expect(result.blobRefs).toEqual([]);
    expect(result.shasToPromote).toEqual([]);
  });
});

describe("migrateOneConversationV1ToV2", () => {
  const conv: Conversation = {
    id: "conv_44444444-4444-4444-8444-444444444444",
    ownerId: "user_1",
    title: "Hello",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    messageCount: 2,
    role: "reader",
    channel: "web",
    pendingConfirmation: null,
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ],
  };

  it("dry-run reports migrated without writing to v2", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    await v1.items.create({ ...(conv as unknown as FakeDoc) });

    const outcome = await migrateOneConversationV1ToV2(
      conv,
      { v1Container: v1 as never, v2Container: v2 as never },
      { dryRun: true },
    );
    expect(outcome).toBe("dry-run");

    // v2 should still be empty.
    expect([...v2._store.keys()]).toEqual([]);
  });

  it("writes root + turn docs to v2 and marks v1 migrated", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    await v1.items.create({ ...(conv as unknown as FakeDoc) });

    const promoteBlob = vi.fn(async (_s: string) => {});
    const outcome = await migrateOneConversationV1ToV2(
      conv,
      { v1Container: v1 as never, v2Container: v2 as never, promoteBlob },
      { dryRun: false },
    );
    expect(outcome).toBe("migrated");

    const v2Partition = v2._store.get(conv.id);
    expect(v2Partition).toBeDefined();
    const root = v2Partition!.get(conv.id) as unknown as ConversationV2Root;
    expect(root.docType).toBe("root");
    expect(root.turnCount).toBe(2);
    const turns = [...v2Partition!.values()].filter((d) => d.docType === "turn");
    expect(turns).toHaveLength(2);

    // v1 doc marked migrated.
    const v1Doc = v1._store.get(conv.ownerId)!.get(conv.id);
    expect(v1Doc).toMatchObject({ migrated: true });

    // No blob refs synthesized for small messages.
    expect(promoteBlob).not.toHaveBeenCalled();
  });

  it("is idempotent on re-run — skip if v2 root already exists", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    await v1.items.create({ ...(conv as unknown as FakeDoc) });
    // First run commits.
    await migrateOneConversationV1ToV2(
      conv,
      { v1Container: v1 as never, v2Container: v2 as never },
      { dryRun: false },
    );
    // Second run: v1 `migrated=true`, outcome = skipped.
    const outcome = await migrateOneConversationV1ToV2(
      { ...conv, migrated: true },
      { v1Container: v1 as never, v2Container: v2 as never },
      { dryRun: false },
    );
    expect(outcome).toBe("skipped");
  });

  it("promotes staging blobs after v2 write", async () => {
    const bigPayload = "y".repeat(4096);
    const bigConv: Conversation = {
      ...conv,
      id: "conv_55555555-5555-4555-8555-555555555555",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_big", content: bigPayload },
          ],
        },
      ],
    };
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    await v1.items.create({ ...(bigConv as unknown as FakeDoc) });

    const offloadToolResult = vi.fn(async () => ({
      _neo_blob_ref: true as const,
      sha256: "sha_xyz",
      sizeBytes: bigPayload.length,
      mediaType: "application/json",
      rawPrefix: "",
      uri: "https://blob/staging/sha_xyz",
      sourceTool: "tool_use_tu_big",
      conversationId: bigConv.id,
    }));
    const promoteBlob = vi.fn(async (_s: string) => {});

    const outcome = await migrateOneConversationV1ToV2(
      bigConv,
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        offloadToolResult,
        promoteBlob,
      },
      { dryRun: false },
    );
    expect(outcome).toBe("migrated");
    expect(promoteBlob).toHaveBeenCalledWith("sha_xyz");

    // A blobref doc landed in v2 alongside the turn.
    const partition = v2._store.get(bigConv.id)!;
    const blobrefs = [...partition.values()].filter((d) => d.docType === "blobref");
    expect(blobrefs).toHaveLength(1);
  });
});

describe("rebuildV2ToV1WithInlining", () => {
  const root: ConversationV2Root = {
    id: "conv_66666666-6666-4666-8666-666666666666",
    docType: "root",
    conversationId: "conv_66666666-6666-4666-8666-666666666666",
    ownerId: "user_1",
    title: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    role: "reader",
    channel: "web",
    schemaVersion: 2,
    retentionClass: "standard-7y",
    turnCount: 1,
    latestCheckpointId: null,
    rollingSummary: null,
    pendingConfirmation: null,
  };

  it("resolves blob-ref descriptors into inline content", async () => {
    const turn: TurnDoc = {
      id: "turn_conv_1",
      docType: "turn",
      conversationId: root.id,
      turnNumber: 1,
      role: "user",
      parentTurnId: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: root.createdAt,
      content: [
        {
          type: "tool_result",
          content: {
            _neo_blob_ref: true,
            sha256: "abc",
            sizeBytes: 5000,
            mediaType: "application/json",
            rawPrefix: "",
            uri: "https://blob/blobs/abc",
            sourceTool: "t",
            conversationId: root.id,
          },
        },
      ],
    };

    const resolveBlob = vi.fn(async () => JSON.stringify({ resolved: true }));
    const result = await rebuildV2ToV1WithInlining(
      root.id,
      root,
      [turn],
      { resolveBlob },
    );
    expect(resolveBlob).toHaveBeenCalledTimes(1);
    if ("rejected" in result) throw new Error("unexpected rejection");
    const block = (result.messages[0].content as unknown as Array<Record<string, unknown>>)[0];
    expect(block.content).toEqual({ resolved: true });
  });

  it("resolves trust-marked envelope STRINGS (runtime persistence shape) — not just raw descriptor objects", async () => {
    // Reviewer merged_bug_003: the real runtime persists
    // `JSON.stringify({ _neo_trust_boundary, data: descriptor })`.
    // Previous rebuildV2ToV1WithInlining only caught the raw-object
    // shape and walked straight past envelope strings, producing
    // content-lossy rebuilds.
    const envelope = JSON.stringify({
      _neo_trust_boundary: { source: "tool_offload", tool: "t", injection_detected: false },
      data: {
        _neo_blob_ref: true,
        sha256: "envsha",
        sizeBytes: 5000,
        mediaType: "application/json",
        rawPrefix: "",
        uri: "https://blob/blobs/envsha",
        sourceTool: "t",
        conversationId: root.id,
      },
    });
    const turn: TurnDoc = {
      id: "turn_conv_1",
      docType: "turn",
      conversationId: root.id,
      turnNumber: 1,
      role: "user",
      parentTurnId: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: root.createdAt,
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_env",
          content: envelope,
        },
      ],
    };

    const resolveBlob = vi.fn(async () => JSON.stringify({ hydrated: true }));
    const result = await rebuildV2ToV1WithInlining(
      root.id,
      root,
      [turn],
      { resolveBlob },
    );
    expect(resolveBlob).toHaveBeenCalledTimes(1);
    if ("rejected" in result) throw new Error("unexpected rejection");
    const block = (result.messages[0].content as unknown as Array<Record<string, unknown>>)[0];
    expect(block.content).toEqual({ hydrated: true });
  });

  it("rejects when rebuilt doc exceeds the 2 MB v1 ceiling", async () => {
    // Forge a turn whose content alone is ~2.5 MB of inline text.
    const huge = "z".repeat(V1_MAX_DOC_BYTES + 1);
    const turn: TurnDoc = {
      id: "turn_conv_1",
      docType: "turn",
      conversationId: root.id,
      turnNumber: 1,
      role: "user",
      parentTurnId: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: root.createdAt,
      content: [{ type: "text", text: huge }],
    };
    const result = await rebuildV2ToV1WithInlining(root.id, root, [turn], {});
    expect("rejected" in result).toBe(true);
    if ("rejected" in result) {
      expect(result.rejected).toBe("oversized");
      expect(result.estimatedBytes).toBeGreaterThan(V1_MAX_DOC_BYTES);
    }
  });
});

describe("runMigration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aggregates a summary across multiple conversations in dry-run", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    const convs: Conversation[] = [
      {
        id: "conv_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerId: "u1",
        title: null,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        messageCount: 1,
        role: "reader",
        channel: "web",
        pendingConfirmation: null,
        messages: [{ role: "user", content: "hi" }],
      },
      {
        id: "conv_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ownerId: "u2",
        title: null,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        messageCount: 1,
        role: "reader",
        channel: "web",
        pendingConfirmation: null,
        messages: [{ role: "assistant", content: "hello" }],
      },
    ];
    async function* gen() {
      for (const c of convs) yield c;
    }
    const summary = await runMigration(
      { dryRun: true, direction: "v1-to-v2" },
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        listConversations: () => gen(),
      },
    );
    expect(summary.total).toBe(2);
    expect(summary.migrated).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.dryRun).toBe(true);
  });

  it("captures failures per-conversation and keeps going", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    // Poison the v2 batch to throw on second conversation.
    let call = 0;
    const origBatch = v2.items.batch.bind(v2.items);
    v2.items.batch = vi.fn(async (ops: unknown, pk: string) => {
      call += 1;
      if (call === 2) throw new Error("synthetic failure");
      return origBatch(
        ops as Parameters<typeof origBatch>[0],
        pk,
      );
    }) as typeof v2.items.batch;

    const convs: Conversation[] = [
      {
        id: "conv_11111111-1111-4111-8111-111111111111",
        ownerId: "u1",
        title: null,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        messageCount: 1,
        role: "reader",
        channel: "web",
        pendingConfirmation: null,
        messages: [{ role: "user", content: "hi" }],
      },
      {
        id: "conv_22222222-2222-4222-8222-222222222222",
        ownerId: "u2",
        title: null,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        messageCount: 1,
        role: "reader",
        channel: "web",
        pendingConfirmation: null,
        messages: [{ role: "user", content: "hi" }],
      },
    ];
    await v1.items.create({ ...(convs[0] as unknown as FakeDoc) });
    await v1.items.create({ ...(convs[1] as unknown as FakeDoc) });

    async function* gen() {
      for (const c of convs) yield c;
    }
    const summary = await runMigration(
      { dryRun: false, direction: "v1-to-v2" },
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        listConversations: () => gen(),
      },
    );
    expect(summary.migrated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0].conversationId).toBe(convs[1].id);
  });

  it("writes checkpoint after each conversation and resumes from afterId", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    let observed: string | null | undefined;
    const cps: Array<{ id: string | null }> = [];
    const convs: Conversation[] = [
      {
        id: "conv_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerId: "u1",
        title: null,
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        messageCount: 1,
        role: "reader",
        channel: "web",
        pendingConfirmation: null,
        messages: [{ role: "user", content: "hi" }],
      },
    ];
    await v1.items.create({ ...(convs[0] as unknown as FakeDoc) });
    async function* gen(filter: { afterId?: string | null }) {
      observed = filter.afterId;
      for (const c of convs) yield c;
    }
    await runMigration(
      { dryRun: true, direction: "v1-to-v2" },
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        listConversations: (f) => gen(f),
      },
      {
        read: async () => ({
          lastProcessedConversationId: "conv_earlier",
          direction: "v1-to-v2",
          updatedAt: "2026-04-20T00:00:00.000Z",
        }),
        write: async (cp) => {
          cps.push({ id: cp.lastProcessedConversationId });
        },
      },
    );
    expect(observed).toBe("conv_earlier");
    expect(cps).toHaveLength(1);
    expect(cps[0].id).toBe(convs[0].id);
  });

  it("clears the checkpoint on successful completion (so a follow-up run doesn't skip v1-only stragglers with lex-low UUIDs)", async () => {
    // Reviewer bug_004: UUID v4 ordering is random, so resume-from-
    // checkpoint can permanently skip conversations created during a
    // migration gap whose IDs sort below the watermark. Auto-clearing
    // the checkpoint on success ensures the next run starts from
    // scratch and picks those stragglers up.
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    const conv: Conversation = {
      id: "conv_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId: "u1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
      role: "reader",
      channel: "web",
      pendingConfirmation: null,
      messages: [{ role: "user", content: "hi" }],
    };
    await v1.items.create({ ...(conv as unknown as FakeDoc) });
    async function* gen() {
      yield conv;
    }
    const cps: Array<{ id: string | null }> = [];
    await runMigration(
      { dryRun: false, direction: "v1-to-v2" },
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        listConversations: () => gen(),
      },
      {
        read: async () => null,
        write: async (cp) => {
          cps.push({ id: cp.lastProcessedConversationId });
        },
      },
    );
    // Two writes: per-conversation watermark, then a final null-clear.
    expect(cps.length).toBeGreaterThanOrEqual(2);
    expect(cps[cps.length - 1].id).toBeNull();
  });

  it("does NOT clear the checkpoint when there are failures (so operators can target a retry)", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    const conv: Conversation = {
      id: "conv_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ownerId: "u1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
      role: "reader",
      channel: "web",
      pendingConfirmation: null,
      messages: [{ role: "user", content: "hi" }],
    };
    // Force v2 batch to always fail → conversation is recorded as failed.
    v2.items.batch = vi.fn(async () => {
      throw new Error("synthetic failure");
    }) as typeof v2.items.batch;
    await v1.items.create({ ...(conv as unknown as FakeDoc) });
    async function* gen() {
      yield conv;
    }
    const cps: Array<{ id: string | null }> = [];
    await runMigration(
      { dryRun: false, direction: "v1-to-v2" },
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        listConversations: () => gen(),
      },
      {
        read: async () => null,
        write: async (cp) => {
          cps.push({ id: cp.lastProcessedConversationId });
        },
      },
    );
    // Only the per-conversation watermark write; no null-clear on failure.
    expect(cps.map((c) => c.id).some((id) => id === null)).toBe(false);
  });

  it("reverse direction rejects oversized conversations with exit code 3 signal", async () => {
    const v1 = makeFakeContainer();
    const v2 = makeFakeContainer();
    const rootId = "conv_99999999-9999-4999-8999-999999999999";
    const huge = "w".repeat(V1_MAX_DOC_BYTES + 1);
    // Seed v2 container with a root + 1 huge turn.
    const root: ConversationV2Root = {
      id: rootId,
      docType: "root",
      conversationId: rootId,
      ownerId: "u1",
      title: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      role: "reader",
      channel: "web",
      schemaVersion: 2,
      retentionClass: "standard-7y",
      turnCount: 1,
      latestCheckpointId: null,
      rollingSummary: null,
      pendingConfirmation: null,
    };
    const turn: TurnDoc = {
      id: `turn_${rootId}_1`,
      docType: "turn",
      conversationId: rootId,
      turnNumber: 1,
      role: "user",
      parentTurnId: null,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: root.createdAt,
      content: [{ type: "text", text: huge }],
    };
    await v2.items.create({ ...(root as unknown as FakeDoc) });
    await v2.items.create({ ...(turn as unknown as FakeDoc) });

    async function* gen() {
      yield {
        id: rootId,
        ownerId: "u1",
        title: null,
        createdAt: root.createdAt,
        updatedAt: root.updatedAt,
        messageCount: 1,
        role: "reader" as const,
        channel: "web" as const,
        messages: [],
        pendingConfirmation: null,
      };
    }

    const summary = await runMigration(
      { dryRun: false, direction: "v2-to-v1" },
      {
        v1Container: v1 as never,
        v2Container: v2 as never,
        listConversations: () => gen(),
      },
    );
    expect(summary.rejectedOversized).toEqual([rootId]);
    expect(summary.failed).toBe(1);
  });
});
