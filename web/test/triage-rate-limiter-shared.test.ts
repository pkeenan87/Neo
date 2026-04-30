import { describe, it, expect, beforeEach, vi } from "vitest";

// Sanity test for the rate-limiter contract: the per-caller cap is
// global across instances because the underlying counter is in
// Cosmos. We don't drive the route handler here — the handler test
// (triage-endpoint.test.ts) covers the wiring. This test pins the
// behaviour of the shared-counter primitive that backs the limiter.

vi.mock("../lib/config", () => ({
  env: { COSMOS_ENDPOINT: "https://mock.documents.azure.com:443/", MOCK_MODE: false },
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), emitEvent: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));
vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(_o: unknown) {}
    database(_n: string) { return { container: () => ({}) }; }
  },
}));

interface Stored {
  resource: Record<string, unknown>;
  etag: string;
}

function makeFakeContainer() {
  const store = new Map<string, Stored>();
  let etagCounter = 0;
  return {
    items: {
      async create<T extends { id: string }>(doc: T): Promise<{ resource: T }> {
        if (store.has(doc.id)) {
          throw Object.assign(new Error("conflict"), { code: 409 });
        }
        const etag = `e${++etagCounter}`;
        store.set(doc.id, { resource: doc as unknown as Record<string, unknown>, etag });
        return { resource: doc };
      },
    },
    item(id: string, _pk: string) {
      return {
        async read<T>(): Promise<{ resource: T | undefined; etag: string | undefined }> {
          const entry = store.get(id);
          return { resource: entry?.resource as T | undefined, etag: entry?.etag };
        },
        async replace<T extends { id: string }>(doc: T) {
          const etag = `e${++etagCounter}`;
          store.set(id, { resource: doc as unknown as Record<string, unknown>, etag });
          return { resource: doc };
        },
        async patch<T>(body: { operations: Array<{ op: string; path: string; value?: unknown }> }) {
          const entry = store.get(id);
          if (!entry) throw Object.assign(new Error("not found"), { code: 404 });
          const next = { ...(entry.resource as Record<string, unknown>) };
          for (const op of body.operations) {
            const field = op.path.replace(/^\//, "");
            if (op.op === "set") next[field] = op.value;
            if (op.op === "incr") next[field] = ((next[field] as number) ?? 0) + (op.value as number);
          }
          const etag = `e${++etagCounter}`;
          store.set(id, { resource: next, etag });
          return { resource: next as unknown as T };
        },
        async delete() {
          store.delete(id);
          return { code: 204 };
        },
      };
    },
  };
}

import { incrementCounter, __setContainerForTest } from "../lib/instance-shared-counter";

describe("triage rate limiter (shared state)", () => {
  beforeEach(() => {
    __setContainerForTest(makeFakeContainer() as never);
  });

  it("global 100-req cap not bypassable by hitting two instances", async () => {
    const key = "rate:triage:caller-abc";
    const win = 15 * 60 * 1000;
    const limit = 100;

    // 50 increments from "instance A".
    for (let i = 0; i < 50; i++) {
      const r = await incrementCounter(key, win, limit);
      expect(r.allowed).toBe(true);
    }
    // 50 from "instance B" (same shared Cosmos store) — still under cap.
    for (let i = 0; i < 50; i++) {
      const r = await incrementCounter(key, win, limit);
      expect(r.allowed).toBe(true);
    }
    // 101st request — over cap.
    const overflow = await incrementCounter(key, win, limit);
    expect(overflow.count).toBe(101);
    expect(overflow.allowed).toBe(false);
  });

  it("per-caller key isolation — caller A's budget doesn't affect caller B", async () => {
    const win = 15 * 60 * 1000;
    const limit = 5;
    for (let i = 0; i < 5; i++) await incrementCounter("rate:triage:alice", win, limit);
    const aliceOver = await incrementCounter("rate:triage:alice", win, limit);
    expect(aliceOver.allowed).toBe(false);

    const bob = await incrementCounter("rate:triage:bob", win, limit);
    expect(bob.allowed).toBe(true);
    expect(bob.count).toBe(1);
  });
});
