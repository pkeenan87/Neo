import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config so the threshold and container name are deterministic
// without depending on the environment. Threshold is 100 bytes for
// small fixtures; the real default is 256 KB.
vi.mock("../lib/config", () => ({
  env: { CLI_STORAGE_ACCOUNT: "mockacct" },
  NEO_BLOB_OFFLOAD_THRESHOLD_BYTES: 100,
  NEO_TOOL_RESULT_BLOB_CONTAINER: "neo-tool-results",
}));

// Silence the logger and allow assertions on the emitted events.
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

// In-memory fake Azure blob store — tracks uploaded content by
// container-scoped blob name. Each uploaded buffer is identity-cached
// so re-upload is a no-op on identical content.
const { mockBlobs, mockUrlFor, CONTAINER_URL } = vi.hoisted(() => {
  const CONTAINER_URL = "https://mockacct.blob.core.windows.net/neo-tool-results";
  const mockBlobs = new Map<string, Buffer>();
  const mockUrlFor = (name: string) => `${CONTAINER_URL}/${name}`;
  return { mockBlobs, mockUrlFor, CONTAINER_URL };
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
      // Source URL is container-scoped; derive the name and copy.
      const prefix = `${CONTAINER_URL}/`;
      if (!sourceUrl.startsWith(prefix)) throw new Error("copy: bad source URL");
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
      const existed = mockBlobs.delete(this.name);
      return { succeeded: existed };
    }
    async downloadToBuffer() {
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
  maybeOffloadToolResult,
  resolveBlobRef,
  promoteStagingBlob,
  isBlobRefDescriptor,
  __resetToolResultBlobStoreForTest,
} from "../lib/tool-result-blob-store";
import type { BlobRefDescriptor } from "../lib/types";

describe("tool-result blob offload", () => {
  beforeEach(() => {
    mockBlobs.clear();
    mockEmitEvent.mockReset();
    mockWarn.mockReset();
    __resetToolResultBlobStoreForTest();
  });

  describe("maybeOffloadToolResult", () => {
    it("passes through inline when payload is below threshold", async () => {
      const small = "x".repeat(50); // 50 bytes, below 100
      const out = await maybeOffloadToolResult(small, {
        conversationId: "conv_1",
        sourceTool: "run_sentinel_kql",
      });
      expect(out).toBe(small);
      expect(mockBlobs.size).toBe(0);
      expect(mockEmitEvent).not.toHaveBeenCalled();
    });

    it("offloads to blob and returns a BlobRefDescriptor when over threshold", async () => {
      const big = "x".repeat(500);
      const out = await maybeOffloadToolResult(big, {
        conversationId: "conv_1",
        sourceTool: "run_sentinel_kql",
      });
      expect(typeof out).toBe("object");
      const descriptor = out as BlobRefDescriptor;
      expect(descriptor._neo_blob_ref).toBe(true);
      expect(descriptor.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(descriptor.sizeBytes).toBe(500);
      expect(descriptor.uri.startsWith(CONTAINER_URL)).toBe(true);
      expect(descriptor.uri.includes("staging/")).toBe(true);
      expect(descriptor.sourceTool).toBe("run_sentinel_kql");
      // One blob exists in staging/.
      expect(mockBlobs.has(`staging/${descriptor.sha256}`)).toBe(true);
      expect(mockEmitEvent).toHaveBeenCalledWith(
        "conversation_blob_offload",
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          conversationId: "conv_1",
          sourceTool: "run_sentinel_kql",
          sha256: descriptor.sha256,
          sizeBytes: 500,
        }),
      );
    });

    it("is idempotent: offloading the same bytes twice produces the same sha/path", async () => {
      const big = "x".repeat(500);
      const a = (await maybeOffloadToolResult(big, {
        conversationId: "conv_1",
        sourceTool: "t",
      })) as BlobRefDescriptor;
      const b = (await maybeOffloadToolResult(big, {
        conversationId: "conv_2",
        sourceTool: "t",
      })) as BlobRefDescriptor;
      expect(a.sha256).toBe(b.sha256);
      expect(a.uri).toBe(b.uri);
      // Only one staging blob persisted.
      expect(mockBlobs.size).toBe(1);
    });

    it("different content hashes to different paths", async () => {
      const a = (await maybeOffloadToolResult("a".repeat(500), {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;
      const b = (await maybeOffloadToolResult("b".repeat(500), {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;
      expect(a.sha256).not.toBe(b.sha256);
      expect(mockBlobs.size).toBe(2);
    });

    it("shortSummary is capped (not the full 500-byte payload)", async () => {
      const big = "x".repeat(500);
      const out = (await maybeOffloadToolResult(big, {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;
      expect(out.shortSummary.length).toBeLessThanOrEqual(281); // 280 + "…"
    });
  });

  describe("promoteStagingBlob", () => {
    it("copies staging/<sha> to blobs/<sha> and deletes the staging copy", async () => {
      const big = "x".repeat(500);
      const out = (await maybeOffloadToolResult(big, {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;

      await promoteStagingBlob(out.sha256);

      expect(mockBlobs.has(`blobs/${out.sha256}`)).toBe(true);
      expect(mockBlobs.has(`staging/${out.sha256}`)).toBe(false);
    });

    it("is idempotent: re-promoting a promoted blob is a no-op", async () => {
      const big = "x".repeat(500);
      const out = (await maybeOffloadToolResult(big, {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;

      await promoteStagingBlob(out.sha256);
      await promoteStagingBlob(out.sha256); // second call — no throw
      expect(mockBlobs.has(`blobs/${out.sha256}`)).toBe(true);
    });
  });

  describe("resolveBlobRef", () => {
    it("fetches from blobs/<sha> after promotion", async () => {
      const big = "x".repeat(500);
      const out = (await maybeOffloadToolResult(big, {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;
      await promoteStagingBlob(out.sha256);

      const resolved = await resolveBlobRef(out);
      expect(resolved).toBe(big);
      expect(mockEmitEvent).toHaveBeenCalledWith(
        "conversation_blob_resolve",
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ sha256: out.sha256 }),
      );
    });

    it("falls back to staging/<sha> when blobs/<sha> doesn't exist (pre-promotion race window)", async () => {
      // Offload but don't promote.
      const big = "x".repeat(500);
      const out = (await maybeOffloadToolResult(big, {
        conversationId: "c",
        sourceTool: "t",
      })) as BlobRefDescriptor;

      const resolved = await resolveBlobRef(out);
      expect(resolved).toBe(big);
    });

    it("refuses to resolve a URI outside the configured container (SSRF guard)", async () => {
      const malicious: BlobRefDescriptor = {
        _neo_blob_ref: true,
        sha256: "deadbeef",
        sizeBytes: 1,
        mediaType: "application/json",
        shortSummary: "evil",
        uri: "https://attacker.example.com/neo-tool-results/blobs/deadbeef",
        sourceTool: "run_sentinel_kql",
      };
      await expect(resolveBlobRef(malicious)).rejects.toThrow(/URI does not belong/);
    });
  });

  describe("isBlobRefDescriptor", () => {
    it("identifies a valid descriptor", () => {
      expect(
        isBlobRefDescriptor({
          _neo_blob_ref: true,
          sha256: "x",
          uri: "https://...",
          sizeBytes: 1,
          mediaType: "application/json",
          shortSummary: "",
          sourceTool: "t",
        }),
      ).toBe(true);
    });

    it("rejects plain strings", () => {
      expect(isBlobRefDescriptor("{}")).toBe(false);
    });

    it("rejects null / undefined / non-object values", () => {
      expect(isBlobRefDescriptor(null)).toBe(false);
      expect(isBlobRefDescriptor(undefined)).toBe(false);
      expect(isBlobRefDescriptor(42)).toBe(false);
    });

    it("rejects an object missing the sentinel", () => {
      expect(
        isBlobRefDescriptor({ sha256: "x", uri: "y" }),
      ).toBe(false);
    });

    it("rejects an object with sentinel but missing required fields", () => {
      expect(isBlobRefDescriptor({ _neo_blob_ref: true })).toBe(false);
    });
  });
});
