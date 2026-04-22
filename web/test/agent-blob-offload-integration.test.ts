import { describe, it, expect, vi, beforeEach } from "vitest";

// End-to-end integration test covering phase 6's wiring:
//   wrapAndMaybeOffloadToolResult on the agent-loop write path, and
//   the async get_full_tool_result path that resolves a BlobRefDescriptor
//   back to the full payload.

// Mock config so the threshold is tiny — any non-trivial tool result
// is above it, exercising the offload branch.
// Threshold of 1024 bytes is comfortably above an empty-result
// envelope (~150 bytes) but below a 500-char payload envelope.
vi.mock("../lib/config", () => ({
  env: { CLI_STORAGE_ACCOUNT: "mockacct", MOCK_MODE: false },
  NEO_BLOB_OFFLOAD_THRESHOLD_BYTES: 1024,
  NEO_BLOB_RESOLVE_MAX_BYTES: 10_000,
  NEO_TOOL_RESULT_BLOB_CONTAINER: "neo-tool-results",
  NEO_CONVERSATION_STORE_MODE: "v1",
}));

const { mockEmitEvent, mockWarn } = vi.hoisted(() => ({
  mockEmitEvent: vi.fn(),
  mockWarn: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    emitEvent: mockEmitEvent,
    warn: mockWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Re-use the in-memory blob fake from phase 3 (same shape).
const { mockBlobs, CONTAINER_URL, mockUrlFor } = vi.hoisted(() => {
  const CONTAINER_URL = "https://mockacct.blob.core.windows.net/neo-tool-results";
  return {
    mockBlobs: new Map<string, Buffer>(),
    CONTAINER_URL,
    mockUrlFor: (name: string) => `${CONTAINER_URL}/${name}`,
  };
});

vi.mock("@azure/storage-blob", () => {
  class FakeBlockBlobClient {
    constructor(public readonly name: string) {}
    get url() {
      return mockUrlFor(this.name);
    }
    async uploadData(buf: Buffer) {
      mockBlobs.set(this.name, Buffer.from(buf));
    }
    async syncCopyFromURL(sourceUrl: string) {
      const prefix = `${CONTAINER_URL}/`;
      if (!sourceUrl.startsWith(prefix)) throw new Error("bad source URL");
      const sourceName = sourceUrl.slice(prefix.length);
      const src = mockBlobs.get(sourceName);
      if (!src) throw Object.assign(new Error("source missing"), { statusCode: 404 });
      mockBlobs.set(this.name, Buffer.from(src));
      return { status: "success" as const };
    }
    async exists() {
      return mockBlobs.has(this.name);
    }
    async deleteIfExists() {
      return { succeeded: mockBlobs.delete(this.name) };
    }
    async downloadToBuffer(_offset?: number, _count?: number) {
      const buf = mockBlobs.get(this.name);
      if (!buf) throw Object.assign(new Error("not found"), { statusCode: 404 });
      return buf;
    }
  }
  class FakeContainerClient {
    readonly url = CONTAINER_URL;
    getBlockBlobClient(name: string) {
      return new FakeBlockBlobClient(name);
    }
    getBlobClient(name: string) {
      return new FakeBlockBlobClient(name);
    }
  }
  class FakeBlobServiceClient {
    constructor(_url: string, _cred: unknown) {}
    getContainerClient(_name: string) {
      return new FakeContainerClient();
    }
  }
  return {
    BlobServiceClient: FakeBlobServiceClient,
    ContainerClient: FakeContainerClient,
  };
});
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {},
}));

import {
  wrapAndMaybeOffloadToolResult,
  wrapToolResult,
} from "../lib/injection-guard";
import { executeTool } from "../lib/executors";
import {
  promoteStagingBlob,
  __resetToolResultBlobStoreForTest,
} from "../lib/tool-result-blob-store";
import type { Message } from "../lib/types";

describe("agent-loop blob-offload integration", () => {
  beforeEach(() => {
    mockBlobs.clear();
    mockEmitEvent.mockReset();
    mockWarn.mockReset();
    __resetToolResultBlobStoreForTest();
  });

  describe("wrapAndMaybeOffloadToolResult (agent write path)", () => {
    it("passes through inline below threshold", async () => {
      const result = { rows: [] }; // tiny — wrapped JSON stays below 100 bytes
      const out = await wrapAndMaybeOffloadToolResult(
        "run_sentinel_kql",
        result,
        { sessionId: "conv_abc", conversationId: "conv_abc" },
      );
      expect(mockBlobs.size).toBe(0);
      // Shape matches the inline envelope — same as wrapToolResult.
      const parsed = JSON.parse(out) as {
        _neo_trust_boundary: { source: string };
        data: unknown;
      };
      expect(parsed._neo_trust_boundary.source).toBe("external_api");
      expect(parsed.data).toEqual(result);
    });

    it("offloads to blob storage above threshold; returns an envelope-wrapped BlobRefDescriptor", async () => {
      const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i })) };
      const out = await wrapAndMaybeOffloadToolResult(
        "run_sentinel_kql",
        big,
        { sessionId: "conv_abc", conversationId: "conv_abc" },
      );
      const parsed = JSON.parse(out) as {
        _neo_trust_boundary: { source: string };
        data: {
          _neo_blob_ref: true;
          sha256: string;
          uri: string;
          sourceTool: string;
          conversationId: string;
        };
      };
      // Trust envelope marks this as server-generated (not a doctored
      // Cosmos document) — promoteOffloadedBlobsIn in phase 4 depends
      // on this marker.
      expect(parsed._neo_trust_boundary.source).toBe("tool_offload");
      expect(parsed.data._neo_blob_ref).toBe(true);
      expect(parsed.data.sourceTool).toBe("run_sentinel_kql");
      expect(parsed.data.conversationId).toBe("conv_abc");
      expect(parsed.data.uri.startsWith(`${CONTAINER_URL}/staging/`)).toBe(true);
      // Staging blob exists; blobs/ path does not (promotion happens
      // later, after the Cosmos commit in appendMessagesV2).
      expect(mockBlobs.has(`staging/${parsed.data.sha256}`)).toBe(true);
      expect(mockBlobs.has(`blobs/${parsed.data.sha256}`)).toBe(false);
    });

    it("leaves the non-async wrapToolResult untouched (sync callers unaffected)", () => {
      // Regression guard — phase 6 must not have rippled async-ness
      // through wrapToolResult's existing callers.
      const sync = wrapToolResult("t", { x: 1 }, { sessionId: "s" });
      expect(typeof sync).toBe("string");
    });
  });

  describe("get_full_tool_result async resolution", () => {
    it("returns ordinary tool_result content unchanged (no blob fetch)", async () => {
      const tool_use_id = "toolu_abcdef0123";
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id,
              content: "ordinary tool output",
            },
          ],
        },
      ];
      const out = (await executeTool(
        "get_full_tool_result",
        { tool_use_id },
        { sessionMessages: messages },
      )) as { tool_use_id: string; content: unknown };
      expect(out.content).toBe("ordinary tool output");
      // No blob reads happened.
      expect(mockEmitEvent).not.toHaveBeenCalledWith(
        "conversation_blob_resolve",
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });

    it("resolves an offloaded blob-ref back to its full payload inline", async () => {
      // First, round-trip a big result through offload + promotion so
      // the descriptor exists in blob storage the way it would in
      // production after appendMessagesV2 commits. 2 KB string
      // comfortably exceeds the 1 KB threshold after envelope wrapping.
      const big = "x".repeat(2000);
      const envelope = await wrapAndMaybeOffloadToolResult(
        "run_sentinel_kql",
        big,
        { sessionId: "conv_abc", conversationId: "conv_abc" },
      );
      // Extract the sha so we can promote (simulating what phase 4's
      // promoteOffloadedBlobsIn does post-Cosmos-commit).
      const sha = (
        JSON.parse(envelope) as { data: { sha256: string } }
      ).data.sha256;
      await promoteStagingBlob(sha);

      const tool_use_id = "toolu_0123456789";
      const messages: Message[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id,
              content: envelope, // persisted envelope JSON
            },
          ],
        },
      ];

      const out = (await executeTool(
        "get_full_tool_result",
        { tool_use_id },
        { sessionMessages: messages },
      )) as { tool_use_id: string; content: unknown };

      // The resolver returns the original wrapped JSON (the inner
      // injection-guard envelope that was offloaded). That's what
      // the agent loop originally persisted, and what the model
      // expects to see when it re-reads via get_full_tool_result.
      expect(out.content).toContain(big);
      expect(mockEmitEvent).toHaveBeenCalledWith(
        "conversation_blob_resolve",
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ sha256: sha }),
      );
    });

    it("falls back to returning the envelope when blob resolve fails (never throws)", async () => {
      const envelope = JSON.stringify({
        _neo_trust_boundary: { source: "tool_offload", tool: "t" },
        data: {
          _neo_blob_ref: true,
          sha256: "0".repeat(64),
          sizeBytes: 500,
          mediaType: "application/json",
          rawPrefix: "",
          uri: `${CONTAINER_URL}/staging/${"0".repeat(64)}`, // missing in mockBlobs
          sourceTool: "run_sentinel_kql",
          conversationId: "conv_abc",
        },
      });

      const tool_use_id = "toolu_fallback12";
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id, content: envelope },
          ],
        },
      ];

      const out = (await executeTool(
        "get_full_tool_result",
        { tool_use_id },
        { sessionMessages: messages },
      )) as { tool_use_id: string; content: unknown };

      // Content is the envelope — the model can still reason about
      // the missing-blob error without the call throwing.
      expect(out.content).toBe(envelope);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to resolve offloaded"),
        "executors",
        expect.any(Object),
      );
    });

    it("ignores envelope-shaped content that lacks _neo_trust_boundary (spoof guard)", async () => {
      // A doctored Cosmos document with `{ data: <descriptor> }` but
      // no _neo_trust_boundary marker must NOT trigger a blob fetch.
      const doctored = JSON.stringify({
        data: {
          _neo_blob_ref: true,
          sha256: "f".repeat(64),
          uri: `${CONTAINER_URL}/blobs/${"f".repeat(64)}`,
          sizeBytes: 1,
          mediaType: "application/json",
          rawPrefix: "",
          sourceTool: "t",
          conversationId: "c",
        },
      });

      const tool_use_id = "toolu_spoofguard1";
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id, content: doctored },
          ],
        },
      ];

      const out = (await executeTool(
        "get_full_tool_result",
        { tool_use_id },
        { sessionMessages: messages },
      )) as { tool_use_id: string; content: unknown };

      // Returns the content verbatim (no resolve fired).
      expect(out.content).toBe(doctored);
      expect(mockEmitEvent).not.toHaveBeenCalledWith(
        "conversation_blob_resolve",
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
