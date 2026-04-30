import { describe, it, expect, vi } from "vitest";

// Verify that production-mode (Cosmos configured + MOCK_MODE=false)
// does NOT consult api-keys.json. The fix from
// _plans/multi-instance-deployment.md closes the multi-instance
// security hole where revoked keys could keep working on instances
// that hadn't re-read the file.

vi.hoisted(() => {
  process.env.COSMOS_ENDPOINT = "https://mock.documents.azure.com:443/";
  process.env.MOCK_MODE = "false";
});

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: mockLoggerError, debug: vi.fn(), emitEvent: vi.fn() },
  hashPii: (s: string) => `hash(${s})`,
}));

// Spy on fs reads — production must NEVER touch api-keys.json.
const { readFileSyncSpy, watchSpy } = vi.hoisted(() => ({
  readFileSyncSpy: vi.fn(() => {
    throw new Error("readFileSync called in production-mode test — should never happen");
  }),
  watchSpy: vi.fn(() => {
    throw new Error("watch() called in production-mode test — should never happen");
  }),
}));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    readFileSync: readFileSyncSpy,
    watch: watchSpy,
  };
});

vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));
vi.mock("../lib/api-key-crypto", () => ({
  encryptApiKey: vi.fn(async (raw: string) => `encrypted:${raw}`),
  decryptApiKey: vi.fn(async (enc: string) => enc.replace(/^encrypted:/, "")),
}));

interface Stored {
  resource: Record<string, unknown>;
}

const { fakeStore, cosmosFailure } = vi.hoisted(() => ({
  fakeStore: new Map<string, Stored>(),
  // Tests can set cosmosFailure.next to a thrown value to simulate a
  // transient outage on the next read — emulates ServiceUnavailable.
  cosmosFailure: { next: null as unknown },
}));
vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(_o: unknown) {}
    database(_n: string) {
      return {
        container: () => ({
          items: {
            async create<T extends { id: string }>(doc: T) {
              fakeStore.set(doc.id, { resource: doc as unknown as Record<string, unknown> });
              return { resource: doc };
            },
            query() {
              return {
                async fetchAll() {
                  return { resources: Array.from(fakeStore.values()).map((s) => s.resource) };
                },
              };
            },
          },
          item(id: string) {
            return {
              async read<T>() {
                if (cosmosFailure.next) {
                  const err = cosmosFailure.next;
                  cosmosFailure.next = null;
                  throw err;
                }
                const entry = fakeStore.get(id);
                return entry
                  ? { resource: entry.resource as unknown as T }
                  : { resource: undefined };
              },
              async patch() { /* no-op */ },
              async replace<T extends { id: string }>(doc: T) {
                fakeStore.set(doc.id, { resource: doc as unknown as Record<string, unknown> });
                return { resource: doc };
              },
            };
          },
        }),
      };
    }
  },
}));

import { findApiKey, hashApiKey } from "../lib/api-key-store";

describe("api-key-store — Cosmos-only in production", () => {
  it("readFileSync is never called at module-load time in production", () => {
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it("Cosmos miss returns undefined — does NOT fall back to file", async () => {
    fakeStore.clear();
    // No file fallback should be consulted; the key isn't in Cosmos
    // so the result is undefined.
    const got = await findApiKey("nonexistent-raw-key");
    expect(got).toBeUndefined();
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  it("Cosmos hit returns the key entry", async () => {
    const rawKey = "test-raw-key-abc123";
    const hash = hashApiKey(rawKey);
    fakeStore.set(hash, {
      resource: {
        id: hash,
        encryptedKey: `encrypted:${rawKey}`,
        role: "reader",
        label: "test",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        createdBy: "owner_1",
        revoked: false,
        lastUsedAt: null,
      },
    });
    const got = await findApiKey(rawKey);
    expect(got).toBeDefined();
    expect(got!.role).toBe("reader");
    expect(got!.label).toBe("test");
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  it("revoked Cosmos key returns undefined regardless of file", async () => {
    const rawKey = "revoked-key-xyz";
    const hash = hashApiKey(rawKey);
    fakeStore.set(hash, {
      resource: {
        id: hash,
        encryptedKey: `encrypted:${rawKey}`,
        role: "reader",
        label: "test",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        createdBy: "owner_1",
        revoked: true,
        lastUsedAt: null,
      },
    });
    const got = await findApiKey(rawKey);
    expect(got).toBeUndefined();
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  it("Cosmos error surfaces a distinct cosmos_unavailable log event", async () => {
    mockLoggerError.mockClear();
    cosmosFailure.next = Object.assign(new Error("Service Unavailable"), { code: 503 });

    const got = await findApiKey("any-key-during-outage");
    // Fail-closed: lookup denies the request.
    expect(got).toBeUndefined();

    // The distinguishing event tag is what on-call dashboards filter on
    // — separates "Cosmos is down" from "bad key" (both surface as 401).
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("Cosmos unavailable"),
      "api-key-store",
      expect.objectContaining({ event: "cosmos_unavailable", errorCode: 503 }),
    );
  });
});
