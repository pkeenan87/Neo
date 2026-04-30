import { describe, it, expect, beforeEach, vi } from "vitest";

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
  const container = {
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
        async replace<T extends { id: string }>(doc: T, opts?: { accessCondition?: { type: string; condition: string } }) {
          const entry = store.get(id);
          if (entry && opts?.accessCondition?.condition && opts.accessCondition.condition !== entry.etag) {
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          }
          const etag = `e${++etagCounter}`;
          store.set(id, { resource: doc as unknown as Record<string, unknown>, etag });
          return { resource: doc };
        },
        async patch<T>(body: { operations: Array<{ op: string; path: string; value?: unknown }> }, opts?: { accessCondition?: { type: string; condition: string } }) {
          const entry = store.get(id);
          if (!entry) throw Object.assign(new Error("not found"), { code: 404 });
          if (opts?.accessCondition?.condition && opts.accessCondition.condition !== entry.etag) {
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          }
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
  return { container, store };
}

import {
  incrementCounter,
  readCounter,
  resetCounter,
  recordOutcome,
  readOutcomeState,
  tripBreaker,
  resetOutcomeWindow,
  __setContainerForTest,
} from "../lib/instance-shared-counter";

describe("instance-shared-counter — counter primitive", () => {
  let fake: ReturnType<typeof makeFakeContainer>;

  beforeEach(() => {
    fake = makeFakeContainer();
    __setContainerForTest(fake.container as never);
  });

  it("creates the counter doc on first increment", async () => {
    const r = await incrementCounter("rate:test", 60_000, 100);
    expect(r).toEqual({ count: 1, allowed: true });
    expect(await readCounter("rate:test")).toBe(1);
  });

  it("increments atomically inside the window", async () => {
    for (let i = 0; i < 5; i++) await incrementCounter("rate:test", 60_000, 100);
    expect(await readCounter("rate:test")).toBe(5);
  });

  it("flips allowed=false once the count exceeds the limit", async () => {
    for (let i = 0; i < 100; i++) await incrementCounter("rate:test", 60_000, 100);
    const over = await incrementCounter("rate:test", 60_000, 100);
    expect(over.count).toBe(101);
    expect(over.allowed).toBe(false);
  });

  it("rolls the window over after windowMs elapses", async () => {
    await incrementCounter("rate:test", 1, 100);
    await new Promise((r) => setTimeout(r, 5));
    const next = await incrementCounter("rate:test", 1, 100);
    // Fresh window — count resets to 1.
    expect(next.count).toBe(1);
  });

  it("resetCounter deletes the doc", async () => {
    await incrementCounter("rate:test", 60_000, 100);
    await resetCounter("rate:test");
    expect(await readCounter("rate:test")).toBe(0);
  });

  it("global cap enforced across instances — 50+50 hits cap on call 101", async () => {
    // Simulate two instances by interleaving increments against the
    // same shared store.
    for (let i = 0; i < 50; i++) {
      await incrementCounter("rate:multi", 60_000, 100);
      await incrementCounter("rate:multi", 60_000, 100);
    }
    expect(await readCounter("rate:multi")).toBe(100);
    const overflow = await incrementCounter("rate:multi", 60_000, 100);
    expect(overflow.count).toBe(101);
    expect(overflow.allowed).toBe(false);
  });

  // The two tests below pin the rate-limiter's safety claim under
  // Cosmos degradation: it must FAIL OPEN. Ops policy is that a
  // storage outage shouldn't lock out legitimate callers — the
  // circuit breaker is what handles persistent failure modes.
  it("fails open on a non-retryable Cosmos error", async () => {
    const failingContainer = {
      items: {
        async create<T>(_doc: T): Promise<{ resource: T }> {
          throw new Error("never reached");
        },
      },
      item(_id: string, _pk: string) {
        return {
          async read<T>(): Promise<{ resource: T | undefined; etag: string | undefined }> {
            throw Object.assign(new Error("Service Unavailable"), { code: 503 });
          },
          async replace<T>(_doc: T) { throw new Error("never reached"); },
          async patch<T>(_body: unknown) { throw new Error("never reached"); },
          async delete() { throw new Error("never reached"); },
        };
      },
    };
    __setContainerForTest(failingContainer as never);
    const r = await incrementCounter("rate:cosmos-down", 60_000, 100);
    expect(r).toEqual({ count: 0, allowed: true });
  });

  it("fails open after retry exhaustion (persistent 412 conflict)", async () => {
    // Container that returns a missing doc on read but always 409s
    // on create — every retry hits the same conflict, the loop
    // burns through PATCH_RETRY_LIMIT without progress. The safety
    // claim is that this still fails open, not closed.
    const conflictContainer = {
      items: {
        async create<T>(_doc: T): Promise<{ resource: T }> {
          throw Object.assign(new Error("conflict"), { code: 409 });
        },
      },
      item(_id: string, _pk: string) {
        return {
          async read<T>(): Promise<{ resource: T | undefined; etag: string | undefined }> {
            return { resource: undefined, etag: undefined };
          },
          async replace<T>(_doc: T) {
            throw Object.assign(new Error("etag mismatch"), { code: 412 });
          },
          async patch<T>(_body: unknown) { throw new Error("never reached"); },
          async delete() { throw new Error("never reached"); },
        };
      },
    };
    __setContainerForTest(conflictContainer as never);
    const r = await incrementCounter("rate:contended", 60_000, 100);
    expect(r).toEqual({ count: 0, allowed: true });
  });

  // Defends against the Cosmos id constraints (`/`, `\`, `?`, `#`,
  // 255-byte cap). Without normalization, a caller-id containing
  // any of those chars throws on create and the outer catch silently
  // promotes the limiter to "always allow" for that caller.
  it("normalizes keys with forbidden Cosmos characters", async () => {
    const r1 = await incrementCounter("rate:triage:user/with/slashes", 60_000, 100);
    expect(r1.allowed).toBe(true);
    expect(r1.count).toBe(1);

    // Calling again with a key that has the same character composition
    // after normalization should hit the same counter (proving normalize
    // is deterministic, not just discarded).
    const r2 = await incrementCounter("rate:triage:user/with/slashes", 60_000, 100);
    expect(r2.count).toBe(2);
  });

  it("normalizes long keys via hashing without crashing", async () => {
    const longCallerId = "x".repeat(400); // exceeds 255-byte Cosmos limit
    const key = `rate:triage:${longCallerId}`;
    const r = await incrementCounter(key, 60_000, 100);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });
});

describe("instance-shared-counter — outcome window primitive", () => {
  let fake: ReturnType<typeof makeFakeContainer>;

  beforeEach(() => {
    fake = makeFakeContainer();
    __setContainerForTest(fake.container as never);
  });

  it("records and reads outcomes within the window", async () => {
    await recordOutcome("breaker:test", true);
    await recordOutcome("breaker:test", false);
    const state = await readOutcomeState("breaker:test", 60_000);
    expect(state.outcomes).toHaveLength(2);
    expect(state.outcomes[0].success).toBe(true);
    expect(state.outcomes[1].success).toBe(false);
    expect(state.trippedAt).toBeNull();
  });

  it("prunes old outcomes outside the window on read", async () => {
    await recordOutcome("breaker:test", true);
    await new Promise((r) => setTimeout(r, 5));
    const state = await readOutcomeState("breaker:test", 1);
    expect(state.outcomes).toHaveLength(0);
  });

  it("tripBreaker sets trippedAt", async () => {
    await tripBreaker("breaker:test");
    const state = await readOutcomeState("breaker:test", 60_000);
    expect(state.trippedAt).not.toBeNull();
  });

  it("resetOutcomeWindow clears trippedAt and outcomes", async () => {
    await recordOutcome("breaker:test", false);
    await tripBreaker("breaker:test");
    await resetOutcomeWindow("breaker:test");
    const state = await readOutcomeState("breaker:test", 60_000);
    expect(state.outcomes).toHaveLength(0);
    expect(state.trippedAt).toBeNull();
  });

  it("bounds the outcome array at ~200 entries", async () => {
    for (let i = 0; i < 250; i++) await recordOutcome("breaker:bounded", true);
    const state = await readOutcomeState("breaker:bounded", 60_000);
    expect(state.outcomes.length).toBeLessThanOrEqual(200);
  });
});
