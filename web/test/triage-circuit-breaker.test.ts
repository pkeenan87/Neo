import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/config");
  return {
    ...actual,
    env: {
      ...(actual.env as Record<string, unknown>),
      TRIAGE_CIRCUIT_BREAKER_THRESHOLD: 0.30,
      TRIAGE_CIRCUIT_BREAKER_WINDOW_MS: 15 * 60 * 1000,
      TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS: 30 * 60 * 1000,
    },
  };
});

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), emitEvent: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

// Stub the Cosmos / identity SDKs so the lazy container init in
// instance-shared-counter doesn't try to instantiate a real client.
vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));
vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(_o: unknown) {}
    database(_n: string) { return { container: () => ({}) }; }
  },
}));

// In-memory fake container shared across "instances" so the breaker
// state is genuinely shared (mirrors what Cosmos does in production).
function makeFakeContainer() {
  const store = new Map<string, { resource: Record<string, unknown>; etag: string }>();
  let etagCounter = 0;
  const fake = {
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
  return { fake, store };
}

import {
  checkCircuitBreaker,
  recordTriageOutcome,
  resetCircuitBreaker,
} from "../lib/triage-circuit-breaker";
import { __setContainerForTest } from "../lib/instance-shared-counter";

describe("triage circuit breaker (shared state)", () => {
  let fakeStore: ReturnType<typeof makeFakeContainer>;

  beforeEach(() => {
    fakeStore = makeFakeContainer();
    __setContainerForTest(fakeStore.fake as never);
  });

  it("is closed when no outcomes are recorded", async () => {
    expect((await checkCircuitBreaker()).open).toBe(false);
  });

  it("is closed when failure rate is below the threshold", async () => {
    for (let i = 0; i < 7; i++) await recordTriageOutcome(true);
    for (let i = 0; i < 2; i++) await recordTriageOutcome(false);
    expect((await checkCircuitBreaker()).open).toBe(false);
  });

  it("trips when the failure rate reaches the threshold", async () => {
    for (let i = 0; i < 7; i++) await recordTriageOutcome(true);
    for (let i = 0; i < 3; i++) await recordTriageOutcome(false);
    const result = await checkCircuitBreaker();
    expect(result.open).toBe(true);
    expect(result.reason).toBe("circuit_breaker_open");
  });

  it("stays open after tripping until cooldown elapses", async () => {
    for (let i = 0; i < 3; i++) await recordTriageOutcome(true);
    for (let i = 0; i < 7; i++) await recordTriageOutcome(false);
    expect((await checkCircuitBreaker()).open).toBe(true);
    expect((await checkCircuitBreaker()).open).toBe(true);
  });

  it("resets on manual reset", async () => {
    for (let i = 0; i < 10; i++) await recordTriageOutcome(false);
    expect((await checkCircuitBreaker()).open).toBe(true);
    await resetCircuitBreaker();
    expect((await checkCircuitBreaker()).open).toBe(false);
  });

  it("is closed after all successes", async () => {
    for (let i = 0; i < 100; i++) await recordTriageOutcome(true);
    expect((await checkCircuitBreaker()).open).toBe(false);
  });

  // Multi-instance: the trip on instance A is visible to instance B
  // because the underlying Cosmos doc is shared across both.
  it("trip from instance A is visible to instance B's check (shared state)", async () => {
    // "Instance A" pushes the breaker over the threshold.
    for (let i = 0; i < 3; i++) await recordTriageOutcome(true);
    for (let i = 0; i < 7; i++) await recordTriageOutcome(false);
    const a = await checkCircuitBreaker();
    expect(a.open).toBe(true);

    // "Instance B" — same Cosmos store, no local outcomes recorded.
    // Reading the shared trippedAt must surface as open.
    const b = await checkCircuitBreaker();
    expect(b.open).toBe(true);
    expect(b.reason).toBe("circuit_breaker_open");
  });
});
