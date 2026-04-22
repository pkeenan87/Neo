import { describe, it, expect, vi, beforeEach } from "vitest";

// Integration tests for the four Teams-bot scenarios from
// _specs/conversation-storage-split-blob-offload.md — run against
// CosmosV2SessionStore + a fake Cosmos container, with the blob
// helpers stubbed. These exercise the *adapter* wired the way Teams
// uses it (session resume, pending-confirmation round-trip, CSV
// attachment, partial-failure on oversized tool result).

vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/" },
  NEO_CONVERSATIONS_V2_CONTAINER: "neo-conversations-v2",
  NEO_RETENTION_CLASS_DEFAULT: "standard-7y",
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

const { mockPromoteStagingBlob, mockMaybeOffload } = vi.hoisted(() => ({
  mockPromoteStagingBlob: vi.fn(async (_sha: string) => {}),
  mockMaybeOffload: vi.fn(),
}));
vi.mock("../lib/tool-result-blob-store", () => ({
  promoteStagingBlob: mockPromoteStagingBlob,
  maybeOffloadToolResult: mockMaybeOffload,
  isBlobRefDescriptor: (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    return (v as { _neo_blob_ref?: unknown })._neo_blob_ref === true;
  },
}));

// ─── Fake Cosmos container ──────────────────────────────────
//
// Mirrors the minimal Container surface exercised by the v2 adapter:
// items.create, items.query (with fetchAll), items.batch, item().read/
// patch/replace/delete. In-memory; keyed by (partitionKey, id).

interface FakeDoc {
  [k: string]: unknown;
  id: string;
  conversationId: string;
}

function makeFakeContainer(opts?: { forceBatchFail?: boolean }) {
  const byPartition = new Map<string, Map<string, FakeDoc>>();
  let forceFail = opts?.forceBatchFail ?? false;
  function getPart(pk: string) {
    if (!byPartition.has(pk)) byPartition.set(pk, new Map());
    return byPartition.get(pk)!;
  }
  return {
    setForceFail(v: boolean) {
      forceFail = v;
    },
    _store: byPartition,
    items: {
      async create<T extends FakeDoc>(doc: T): Promise<{ resource: T }> {
        getPart(doc.conversationId ?? doc.id).set(doc.id, doc);
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
          resourceBody?: unknown;
        }>,
        partitionKey: string,
      ) {
        if (forceFail) return { code: 500 };
        for (const op of operations) {
          if (op.operationType === "Create") {
            const doc = op.resourceBody as FakeDoc;
            getPart(partitionKey).set(doc.id, doc);
          } else if (op.operationType === "Patch") {
            const existing = getPart(partitionKey).get(op.id!);
            if (!existing) return { code: 404 };
            const patchOps = (op.resourceBody as {
              operations: Array<{ op: string; path: string; value: unknown }>;
            }).operations;
            for (const p of patchOps) {
              if (p.op === "set") {
                const field = p.path.replace(/^\//, "");
                existing[field] = p.value;
              }
            }
          }
        }
        return { code: 200 };
      },
    },
    item(id: string, partitionKey: string) {
      return {
        async read<T>() {
          const doc = byPartition.get(partitionKey)?.get(id);
          return { resource: doc as unknown as T, etag: doc ? "fake-etag" : undefined };
        },
        async patch(body: {
          operations: Array<{ op: string; path: string; value: unknown }>;
        }) {
          const doc = byPartition.get(partitionKey)?.get(id);
          if (!doc) {
            throw Object.assign(new Error("not found"), { code: 404 });
          }
          for (const p of body.operations) {
            if (p.op === "set") {
              const field = p.path.replace(/^\//, "");
              doc[field] = p.value;
            }
          }
          return { resource: doc };
        },
        async replace(doc: FakeDoc) {
          getPart(partitionKey).set(doc.id, doc);
          return { resource: doc };
        },
        async delete() {
          byPartition.get(partitionKey)?.delete(id);
          return { code: 204 };
        },
      };
    },
  };
}

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(_o: unknown) {}
    database(_n: string) {
      return { container: () => ({}) };
    }
  },
}));
vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));

import {
  CosmosV2SessionStore,
  __resetV2ContainerForTest,
  createConversationV2,
  appendMessagesV2,
  appendCsvAttachmentV2,
  getCsvAttachmentsV2,
} from "../lib/conversation-store-v2";
import type { Message, PendingTool } from "../lib/types";

// ─── Tests ──────────────────────────────────────────────────

describe("Teams-bot integration: CosmosV2SessionStore scenarios", () => {
  let fake: ReturnType<typeof makeFakeContainer>;

  beforeEach(() => {
    fake = makeFakeContainer();
    __resetV2ContainerForTest(fake as unknown as Parameters<typeof __resetV2ContainerForTest>[0]);
    mockPromoteStagingBlob.mockClear();
    mockMaybeOffload.mockReset();
  });

  it("scenario 1: resume across pod restart — saveMessages then fresh store.get returns the same messages", async () => {
    const storeA = new CosmosV2SessionStore();
    const sessionId = await storeA.create("reader", "owner_1", "teams");

    const messages: Message[] = [
      { role: "user", content: "who signed in last night?" },
      { role: "assistant", content: "I can run a KQL query for that." },
    ];
    await storeA.saveMessages(sessionId, messages, "Signin investigation");

    // Fresh store instance (new pod / new process) — reads from the
    // same underlying Cosmos state.
    const storeB = new CosmosV2SessionStore();
    const session = await storeB.get(sessionId);
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0].content).toBe("who signed in last night?");
    expect(session!.messages[1].content).toBe(
      "I can run a KQL query for that.",
    );
  });

  it("scenario 2: pending-confirmation round-trip across store instances", async () => {
    const storeA = new CosmosV2SessionStore();
    const sessionId = await storeA.create("admin", "owner_1", "teams");

    const pending: PendingTool = {
      id: "tu_1",
      name: "reset_user_password",
      input: { upn: "alice@corp.com", justification: "incident ticket 42" },
    };
    await storeA.setPendingConfirmation(sessionId, pending);

    // Fresh instance sees the pending confirmation.
    const storeB = new CosmosV2SessionStore();
    const session = await storeB.get(sessionId);
    expect(session).not.toBeNull();
    expect(session!.pendingConfirmation).toMatchObject({
      id: "tu_1",
      name: "reset_user_password",
    });

    // Clearing returns the previously-stored pending tool + the
    // subsequent get() sees no pending.
    const cleared = await storeB.clearPendingConfirmation(sessionId);
    expect(cleared).toMatchObject({ id: "tu_1", name: "reset_user_password" });
    const after = await storeB.get(sessionId);
    expect(after!.pendingConfirmation).toBeNull();
  });

  it("scenario 3: CSV attachment appended in one process is visible from another", async () => {
    const storeA = new CosmosV2SessionStore();
    const sessionId = await storeA.create("reader", "owner_1", "teams");

    // CSV attachments are appended via the module-level helper (the
    // route layer calls appendCsvAttachment from conversation-store
    // which dispatches to this function). Not exposed on the
    // SessionStore interface in v1 or v2 — same shape as v1.
    const attachment = {
      csvId: "csv_abc",
      filename: "users.csv",
      blobUrl: "https://blob/csvs/abc",
      rowCount: 120,
      columns: ["user", "email", "role", "last_signin"],
      sampleRows: [["alice", "alice@corp.com", "eng", "2026-04-01"]],
      createdAt: "2026-04-20T10:00:00.000Z",
    };
    await appendCsvAttachmentV2(sessionId, "owner_1", attachment);

    // Fresh-process read sees the attachment via the dedicated
    // getter. SessionStore.get returns a Session (without CSVs — same
    // shape as v1); csv access is via getCsvAttachments*.
    const fetched = await getCsvAttachmentsV2(sessionId, "owner_1");
    expect(fetched).toHaveLength(1);
    expect(fetched[0].filename).toBe("users.csv");
    expect(fetched[0].csvId).toBe("csv_abc");

    // The fresh SessionStore.get still works across the CSV write —
    // the root patch didn't corrupt the session metadata.
    const storeB = new CosmosV2SessionStore();
    const session = await storeB.get(sessionId);
    expect(session).not.toBeNull();
    expect(session!.ownerId).toBe("owner_1");
  });

  it("scenario 4: blob write succeeds + Cosmos batch fails → no promote; retry succeeds + single promote", async () => {
    const sessionId = await createConversationV2("owner_1", "admin", "teams");

    const bigPayload = "x".repeat(1024);
    // Simulate the offload helper — the blob IS written to staging.
    mockMaybeOffload.mockResolvedValue({
      _neo_blob_ref: true,
      sha256: "sha_partial",
      sizeBytes: bigPayload.length,
      mediaType: "application/json",
      rawPrefix: "xxxxx",
      uri: "https://blob/staging/sha_partial",
      sourceTool: "run_sentinel_kql",
      conversationId: sessionId,
    });

    // Messages that carry the already-offloaded descriptor inside a
    // tool_result content block (matches the agent-loop wiring from
    // phase 6 — wrapAndMaybeOffloadToolResult).
    const envelope = JSON.stringify({
      _neo_trust_boundary: {
        source: "tool_offload",
        tool: "run_sentinel_kql",
        injection_detected: false,
      },
      data: {
        _neo_blob_ref: true,
        sha256: "sha_partial",
        sizeBytes: bigPayload.length,
        mediaType: "application/json",
        rawPrefix: "xxxxx",
        uri: "https://blob/staging/sha_partial",
        sourceTool: "run_sentinel_kql",
        conversationId: sessionId,
      },
    });
    const messagesWithDescriptor: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: envelope },
        ] as unknown as Message["content"],
      },
    ];

    // First attempt: batch fails mid-write.
    fake.setForceFail(true);
    await expect(
      appendMessagesV2(sessionId, "owner_1", messagesWithDescriptor),
    ).rejects.toThrow(/batch failed/);

    // Critical invariant: blob was NOT promoted because the Cosmos
    // commit never completed. The staging-blob lifecycle policy is
    // the safety net that reaps the orphan.
    expect(mockPromoteStagingBlob).not.toHaveBeenCalled();

    // Retry with the same content. Same sha because the envelope is
    // byte-identical — staging idempotent.
    fake.setForceFail(false);
    await appendMessagesV2(sessionId, "owner_1", messagesWithDescriptor);
    expect(mockPromoteStagingBlob).toHaveBeenCalledTimes(1);
    expect(mockPromoteStagingBlob).toHaveBeenCalledWith("sha_partial");
  });
});
