import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Controllable mode. We reset it between tests so each scenario runs
// in isolation. Using a `mode` holder object means the config import
// surface is fully mockable without remounting the module graph.
const modeHolder = vi.hoisted(() => ({
  mode: "v1" as "v1" | "v2" | "dual-read" | "dual-write",
}));
vi.mock("../lib/config", () => ({
  get NEO_CONVERSATION_STORE_MODE() {
    return modeHolder.mode;
  },
  NEO_CONVERSATIONS_V2_CONTAINER: "neo-conversations-v2",
  NEO_RETENTION_CLASS_DEFAULT: "standard-7y",
}));

const { mockInfo, mockWarn } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    info: mockInfo,
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
    emitEvent: vi.fn(),
  },
  hashPii: (s: string) => `hash(${s})`,
}));

// conversation-store-v2 pulls in @azure/cosmos + identity at module
// load. The mock never actually calls those, but the imports resolve.
vi.mock("@azure/cosmos", () => ({ CosmosClient: class {} }));
vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));

// tool-result-blob-store similarly pulls in the Azure SDKs; not
// exercised in this test but needs to resolve.
vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: class {},
  ContainerClient: class {},
}));

import { MockConversationStore } from "../lib/mock-conversation-store";

// Build an isolated temp path per test so file state doesn't leak.
function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-mock-test-"));
  return join(dir, "conversations.json");
}

function readJson(path: string): { version: number } & Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as {
    version: number;
  } & Record<string, unknown>;
}

describe("MockConversationStore on-disk parity", () => {
  let tempPath: string;
  let store: MockConversationStore;

  beforeEach(() => {
    tempPath = makeTempPath();
    modeHolder.mode = "v1";
    mockInfo.mockReset();
    mockWarn.mockReset();
  });

  afterEach(() => {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe("v1 mode (legacy file format)", () => {
    it("persists as { version: 1, conversations: [] } and round-trips", async () => {
      modeHolder.mode = "v1";
      store = new MockConversationStore(tempPath);
      const id = await store.createConversation("owner_1", "reader", "web");
      await store.appendMessages(id, "owner_1", [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
      ]);

      const persisted = readJson(tempPath);
      expect(persisted.version).toBe(1);
      expect(Array.isArray(persisted.conversations)).toBe(true);
      const convs = persisted.conversations as Array<{ id: string; messages: unknown[] }>;
      expect(convs).toHaveLength(1);
      expect(convs[0].id).toBe(id);
      expect(convs[0].messages).toHaveLength(2);

      // Fresh instance reads the same file cleanly.
      const reloaded = new MockConversationStore(tempPath);
      const conv = await reloaded.getConversation(id, "owner_1");
      expect(conv?.messages).toHaveLength(2);
    });
  });

  describe("v2 mode (split-document file format)", () => {
    it("persists as { version: 2, roots, turns, blobRefs, checkpoints }", async () => {
      modeHolder.mode = "v2";
      store = new MockConversationStore(tempPath);
      const id = await store.createConversation("owner_1", "reader", "web");
      await store.appendMessages(id, "owner_1", [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
      ]);

      const persisted = readJson(tempPath);
      expect(persisted.version).toBe(2);
      // Expected shape: roots[1], turns[2], blobRefs[] empty, checkpoints[] empty.
      expect(Array.isArray(persisted.roots)).toBe(true);
      expect(Array.isArray(persisted.turns)).toBe(true);
      expect(Array.isArray(persisted.blobRefs)).toBe(true);
      expect(Array.isArray(persisted.checkpoints)).toBe(true);
      const roots = persisted.roots as Array<{ id: string; docType: string; schemaVersion: number }>;
      const turns = persisted.turns as Array<{ docType: string; turnNumber: number; conversationId: string }>;
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe(id);
      expect(roots[0].docType).toBe("root");
      expect(roots[0].schemaVersion).toBe(2);
      expect(turns).toHaveLength(2);
      expect(turns[0].docType).toBe("turn");
      expect(turns[0].conversationId).toBe(id);
      expect(turns.map((t) => t.turnNumber).sort()).toEqual([1, 2]);
    });

    it("v2 file round-trips back into a working Conversation", async () => {
      modeHolder.mode = "v2";
      store = new MockConversationStore(tempPath);
      const id = await store.createConversation("owner_1", "reader", "web");
      await store.appendMessages(id, "owner_1", [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ]);

      const reloaded = new MockConversationStore(tempPath);
      const conv = await reloaded.getConversation(id, "owner_1");
      expect(conv?.messages.map((m) => m.content)).toEqual(["q1", "a1", "q2"]);
      expect(conv?.messageCount).toBe(3);
    });

    it("multiple conversations are split correctly (turns scoped by conversationId)", async () => {
      modeHolder.mode = "v2";
      store = new MockConversationStore(tempPath);
      const a = await store.createConversation("owner_1", "reader", "web");
      const b = await store.createConversation("owner_1", "reader", "web");
      await store.appendMessages(a, "owner_1", [{ role: "user", content: "A1" }]);
      await store.appendMessages(b, "owner_1", [
        { role: "user", content: "B1" },
        { role: "assistant", content: "B2" },
      ]);

      const persisted = readJson(tempPath);
      const turns = persisted.turns as Array<{ conversationId: string; content: unknown }>;
      expect(turns.filter((t) => t.conversationId === a)).toHaveLength(1);
      expect(turns.filter((t) => t.conversationId === b)).toHaveLength(2);
    });
  });

  describe("auto-migration v1 → v2", () => {
    it("reads a legacy v1 file and on next save writes v2 format", async () => {
      // Seed a legacy file manually.
      mkdirSync(join(tempPath, ".."), { recursive: true });
      const legacy = {
        version: 1,
        conversations: [
          {
            id: "conv_legacy",
            ownerId: "owner_1",
            title: "Old",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            messageCount: 2,
            role: "reader",
            channel: "web",
            messages: [
              { role: "user", content: "legacy-q" },
              { role: "assistant", content: "legacy-a" },
            ],
            pendingConfirmation: null,
          },
        ],
      };
      writeFileSync(tempPath, JSON.stringify(legacy, null, 2), "utf-8");

      // Now flip to v2 mode and open the store. Load accepts v1,
      // but the next save must emit v2.
      modeHolder.mode = "v2";
      store = new MockConversationStore(tempPath);
      const conv = await store.getConversation("conv_legacy", "owner_1");
      expect(conv?.messages).toHaveLength(2);

      // Trigger a save.
      await store.updateConversationTitle("conv_legacy", "owner_1", "New Title");

      const persisted = readJson(tempPath);
      expect(persisted.version).toBe(2);
      const roots = persisted.roots as Array<{ id: string; title: string }>;
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe("conv_legacy");
      expect(roots[0].title).toBe("New Title");
      const turns = persisted.turns as Array<{ content: unknown }>;
      expect(turns.map((t) => t.content)).toEqual(["legacy-q", "legacy-a"]);
    });

    it("reading a v2 file while in v1 mode downgrades the next save to v1 format", async () => {
      // Seed a v2 file manually.
      const v2File = {
        version: 2,
        roots: [
          {
            id: "conv_x",
            docType: "root",
            conversationId: "conv_x",
            ownerId: "owner_1",
            title: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            role: "reader",
            channel: "web",
            schemaVersion: 2,
            retentionClass: "standard-7y",
            turnCount: 1,
            latestCheckpointId: null,
            rollingSummary: null,
            pendingConfirmation: null,
          },
        ],
        turns: [
          {
            id: "turn_conv_x_1",
            docType: "turn",
            conversationId: "conv_x",
            turnNumber: 1,
            role: "user",
            content: "q",
            parentTurnId: null,
            inputTokens: 0,
            outputTokens: 0,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        blobRefs: [],
        checkpoints: [],
      };
      mkdirSync(join(tempPath, ".."), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(v2File, null, 2), "utf-8");

      modeHolder.mode = "v1";
      store = new MockConversationStore(tempPath);
      const conv = await store.getConversation("conv_x", "owner_1");
      expect(conv?.messages.map((m) => m.content)).toEqual(["q"]);

      await store.appendMessages("conv_x", "owner_1", [
        { role: "assistant", content: "a" },
      ]);

      const persisted = readJson(tempPath);
      expect(persisted.version).toBe(1);
      const convs = persisted.conversations as Array<{ id: string; messages: unknown[] }>;
      expect(convs[0].id).toBe("conv_x");
      expect(convs[0].messages).toHaveLength(2);
    });
  });

  describe("blob offload stays inline in mock", () => {
    it("large tool_result content persists inline (no blob store called)", async () => {
      modeHolder.mode = "v2";
      store = new MockConversationStore(tempPath);
      const id = await store.createConversation("owner_1", "reader", "web");
      const huge = "x".repeat(50_000); // well above prod's 256 KB? no — but above blob thresh in tests
      await store.appendMessages(id, "owner_1", [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: huge }],
        },
      ]);

      const persisted = readJson(tempPath);
      const turns = persisted.turns as Array<{ content: unknown }>;
      expect(turns).toHaveLength(1);
      // Content stays inline as a tool_result block — no blob
      // descriptor envelope, because the mock's save() never offloads.
      // The agent loop (which IS what triggers offload in prod) is
      // outside this test's scope; here we're confirming the mock's
      // serialization doesn't mutate content.
      const content = (turns[0].content as Array<{ type: string; content: string }>)[0];
      expect(content.type).toBe("tool_result");
      expect(content.content).toBe(huge);
    });
  });

  describe("malformed on-disk file", () => {
    it("unknown version yields empty store with a warn log", async () => {
      mkdirSync(join(tempPath, ".."), { recursive: true });
      writeFileSync(tempPath, JSON.stringify({ version: 99 }), "utf-8");

      store = new MockConversationStore(tempPath);
      const out = await store.listConversations("owner_1");
      expect(out).toEqual([]);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("unknown version"),
        "mock-conversation-store",
        expect.any(Object),
      );
    });

    it("JSON parse error yields empty store with a warn log", async () => {
      mkdirSync(join(tempPath, ".."), { recursive: true });
      writeFileSync(tempPath, "{ not-json", "utf-8");

      store = new MockConversationStore(tempPath);
      const out = await store.listConversations("owner_1");
      expect(out).toEqual([]);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load"),
        "mock-conversation-store",
        expect.any(Object),
      );
    });
  });
});

describe("MockConversationStore existence check", () => {
  it("does not create the file until first save", () => {
    const path = makeTempPath();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const unused = new MockConversationStore(path);
    expect(existsSync(path)).toBe(false);
    rmSync(path, { force: true });
  });
});
