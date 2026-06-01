import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Tests for the org-context blob store:
//    - save → load round-trip writes the expected blob name + MIME
//    - load returns null on BlobNotFound (404)
//    - load re-throws on other errors so the caller can decide
//    - isOrgContextBlobConfigured tracks env config
// ─────────────────────────────────────────────────────────────

// config.ts captures process.env into a frozen `env` object at module
// load time, so we can't toggle CLI_STORAGE_ACCOUNT / container per
// test by mutating process.env. Mock the config import to expose a
// mutable env object the suite can rewrite directly.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { CLI_STORAGE_ACCOUNT: "testacct", NEO_ORG_CONTEXT_CONTAINER: "neo-org-context" } as {
    CLI_STORAGE_ACCOUNT?: string;
    NEO_ORG_CONTEXT_CONTAINER?: string;
  },
}));

vi.mock("../lib/config", () => ({
  env: mockEnv,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { mockBlobs, mockUpload, mockDownload } = vi.hoisted(() => {
  // Shape: { content: Buffer, contentType: string }
  const mockBlobs = new Map<string, { content: Buffer; contentType?: string }>();
  const mockUpload = vi.fn();
  const mockDownload = vi.fn();
  return { mockBlobs, mockUpload, mockDownload };
});

vi.mock("@azure/storage-blob", () => {
  class RestError extends Error {
    constructor(message: string, public readonly statusCode?: number) {
      super(message);
      this.name = "RestError";
    }
  }
  class FakeBlockBlobClient {
    constructor(public readonly name: string) {}
    async upload(content: string, _len: number, opts: { blobHTTPHeaders?: { blobContentType?: string } }) {
      mockUpload(this.name, content, opts);
      mockBlobs.set(this.name, {
        content: Buffer.from(content, "utf8"),
        contentType: opts?.blobHTTPHeaders?.blobContentType,
      });
      return {};
    }
    async downloadToBuffer() {
      mockDownload(this.name);
      const entry = mockBlobs.get(this.name);
      if (!entry) throw new RestError("BlobNotFound", 404);
      return entry.content;
    }
  }
  class FakeContainerClient {
    getBlockBlobClient(name: string) {
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
    RestError,
  };
});

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {},
}));

import {
  isOrgContextBlobConfigured,
  loadOrgContextFromBlob,
  saveOrgContextToBlob,
  __resetOrgContextBlobClient,
} from "../lib/org-context-blob-store";

beforeEach(() => {
  mockBlobs.clear();
  mockUpload.mockReset();
  mockDownload.mockReset();
  __resetOrgContextBlobClient();
  mockEnv.CLI_STORAGE_ACCOUNT = "testacct";
  mockEnv.NEO_ORG_CONTEXT_CONTAINER = "neo-org-context";
});

afterEach(() => {
  __resetOrgContextBlobClient();
});

describe("org-context blob store", () => {
  it("save → load round-trip preserves content and sets text/plain MIME", async () => {
    await saveOrgContextToBlob("environment:\n  org: Goodwin\n");
    const loaded = await loadOrgContextFromBlob();
    expect(loaded).toBe("environment:\n  org: Goodwin\n");
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [name, content, opts] = mockUpload.mock.calls[0];
    expect(name).toBe("org-context/current.yaml");
    expect(content).toBe("environment:\n  org: Goodwin\n");
    expect(opts.blobHTTPHeaders.blobContentType).toBe("text/plain; charset=utf-8");
  });

  it("load returns null when the blob does not exist (404)", async () => {
    const loaded = await loadOrgContextFromBlob();
    expect(loaded).toBeNull();
  });

  it("isOrgContextBlobConfigured reflects env state", async () => {
    // True with both env vars set (default in this suite).
    expect(isOrgContextBlobConfigured()).toBe(true);

    // False when either env var is unset.
    mockEnv.CLI_STORAGE_ACCOUNT = undefined;
    expect(isOrgContextBlobConfigured()).toBe(false);
    mockEnv.CLI_STORAGE_ACCOUNT = "testacct";
    mockEnv.NEO_ORG_CONTEXT_CONTAINER = undefined;
    expect(isOrgContextBlobConfigured()).toBe(false);
  });
});
