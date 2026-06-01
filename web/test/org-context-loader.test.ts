import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────
//  Tests for the three-tier org-context loader in config.ts:
//    - Blob tier returned when content present and configured
//    - Falls through to Key Vault when blob empty
//    - Falls through to env var when blob + KV empty
//    - Transient blob/KV errors do NOT poison the 60s cache
//    - Length cap enforced (returns null + warns above limit)
//    - Warn threshold logged once per call
// ─────────────────────────────────────────────────────────────

// Hoisted spies so the mocked modules can read them inside vi.mock factories.
const {
  blobConfigured,
  blobLoadImpl,
  kvLoadImpl,
} = vi.hoisted(() => ({
  blobConfigured: { value: false },
  blobLoadImpl: { fn: vi.fn<() => Promise<string | null>>() },
  kvLoadImpl: { fn: vi.fn<(name: string) => Promise<string | null>>() },
}));

vi.mock("../lib/org-context-blob-store", () => ({
  isOrgContextBlobConfigured: () => blobConfigured.value,
  loadOrgContextFromBlob: () => blobLoadImpl.fn(),
}));

vi.mock("../lib/secrets", () => ({
  getToolSecret: (name: string) => kvLoadImpl.fn(name),
  setToolSecret: vi.fn(),
}));

import { clearOrgContextCache, getSystemPrompt } from "../lib/config";

// Extract the injected org_context block (if any) from a built system
// prompt. We don't have a direct `loadOrgContext` export; the public
// surface is `getSystemPrompt`, which injects between an anchor.
function extractInjected(prompt: string): string | null {
  const m = prompt.match(/<org_context>\n([\s\S]*?)\n<\/org_context>/);
  return m ? m[1] : null;
}

beforeEach(() => {
  clearOrgContextCache();
  blobConfigured.value = false;
  blobLoadImpl.fn = vi.fn<() => Promise<string | null>>();
  kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>();
  delete process.env.ORG_CONTEXT;
  vi.restoreAllMocks();
});

describe("loadOrgContext (via getSystemPrompt)", () => {
  it("uses blob content when configured and present", async () => {
    blobConfigured.value = true;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => "BLOB_CONTENT");
    kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>(async () => "KV_CONTENT");
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBe("BLOB_CONTENT");
    // KV is not queried when blob already returned content.
    expect(kvLoadImpl.fn).not.toHaveBeenCalled();
  });

  it("falls through to Key Vault when blob is unconfigured", async () => {
    blobConfigured.value = false;
    kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>(async () => "KV_CONTENT");
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBe("KV_CONTENT");
  });

  it("falls through to Key Vault when blob returns null", async () => {
    blobConfigured.value = true;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => null);
    kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>(async () => "KV_CONTENT");
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBe("KV_CONTENT");
  });

  it("falls through to env var when both blob and KV return null", async () => {
    blobConfigured.value = true;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => null);
    kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>(async () => null);
    process.env.ORG_CONTEXT = "ENV_CONTENT";
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBe("ENV_CONTENT");
  });

  it("injects nothing when every tier is empty", async () => {
    blobConfigured.value = false;
    kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>(async () => null);
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBeNull();
  });

  it("falls through to KV on transient blob error and does NOT cache", async () => {
    blobConfigured.value = true;
    let blobCalls = 0;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => {
      blobCalls += 1;
      if (blobCalls === 1) throw new Error("503 temporarily unavailable");
      return "BLOB_AFTER_RECOVERY";
    });
    kvLoadImpl.fn = vi.fn<(name: string) => Promise<string | null>>(async () => "KV_FALLBACK");

    // First call: blob throws → KV fallback used, NOT cached.
    const first = await getSystemPrompt("reader");
    expect(extractInjected(first)).toBe("KV_FALLBACK");

    // Second call (no cache): blob recovers, content updates.
    const second = await getSystemPrompt("reader");
    expect(extractInjected(second)).toBe("BLOB_AFTER_RECOVERY");
    expect(blobLoadImpl.fn).toHaveBeenCalledTimes(2);
  });

  it("caches successful blob reads for 60s (next call is a hit)", async () => {
    blobConfigured.value = true;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => "CACHED_BLOB");
    const first = await getSystemPrompt("reader");
    expect(extractInjected(first)).toBe("CACHED_BLOB");
    const second = await getSystemPrompt("reader");
    expect(extractInjected(second)).toBe("CACHED_BLOB");
    expect(blobLoadImpl.fn).toHaveBeenCalledTimes(1);
  });

  it("rejects content above ORG_CONTEXT_MAX_CHARS and logs a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    blobConfigured.value = true;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => "A".repeat(100_001));
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/exceeds maximum length/);
  });

  it("warns but still injects when content is in the warn band", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    blobConfigured.value = true;
    blobLoadImpl.fn = vi.fn<() => Promise<string | null>>(async () => "A".repeat(20_001));
    const prompt = await getSystemPrompt("reader");
    expect(extractInjected(prompt)).toBe("A".repeat(20_001));
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/warning threshold/);
  });
});
