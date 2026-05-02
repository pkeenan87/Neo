import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Container } from "@azure/cosmos";

// Mock config so the v2 adapter has a valid COSMOS_ENDPOINT target
// without real env vars.
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

vi.mock("../lib/tool-result-blob-store", () => ({
  promoteStagingBlob: vi.fn(async () => {}),
  isBlobRefDescriptor: () => false,
}));

import {
  deleteConversationV2,
  updateTitleV2,
  __resetV2ContainerForTest,
} from "../lib/conversation-store-v2";
import { LegalHoldViolationError } from "../lib/retention";
import type { RetentionClass } from "../lib/types";

// Minimal fake Container — read returns a stored root; patch / delete /
// batch are stubs the legal-hold gate must NOT reach when the gate fires.
// We deliberately avoid asserting the full ConversationV2Root shape
// because the gate only consults `retentionClass` + `ownerId` + `docType`.
function makeFakeContainerWithRoot(root: Record<string, unknown>): {
  container: Container;
  patchSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
  batchSpy: ReturnType<typeof vi.fn>;
} {
  const patchSpy = vi.fn(async () => ({ resource: root }));
  const deleteSpy = vi.fn(async () => ({ code: 204 }));
  const batchSpy = vi.fn(async () => ({ code: 200 }));

  const container = {
    items: {
      query: () => ({ fetchAll: async () => ({ resources: [{ id: root.id }] }) }),
      batch: () => batchSpy(),
    },
    item(id: string, _pk: string) {
      return {
        read: async () =>
          id === root.id
            ? { resource: root, etag: "etag-1" }
            : { resource: undefined, etag: undefined },
        patch: () => patchSpy(),
        delete: () => deleteSpy(),
      };
    },
  } as unknown as Container;

  return { container, patchSpy, deleteSpy, batchSpy };
}

function makeRoot(retentionClass: RetentionClass): Record<string, unknown> {
  return {
    id: "conv-1",
    conversationId: "conv-1",
    docType: "root",
    ownerId: "owner-1",
    title: "Old title",
    role: "admin",
    channel: "web",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 0,
    retentionClass,
    ttl: -1,
  };
}

beforeEach(() => {
  __resetV2ContainerForTest(null);
});

describe("deleteConversationV2 — direct legal-hold rejection", () => {
  it("throws LegalHoldViolationError carrying retentionClass and attempted='delete'", async () => {
    const { container, deleteSpy, batchSpy } = makeFakeContainerWithRoot(makeRoot("legal-hold"));
    __resetV2ContainerForTest(container);

    await expect(deleteConversationV2("conv-1", "owner-1")).rejects.toBeInstanceOf(
      LegalHoldViolationError,
    );

    // The store must not enumerate or delete anything once the gate fires.
    expect(batchSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();

    // Re-throw to inspect the typed properties.
    try {
      await deleteConversationV2("conv-1", "owner-1");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as LegalHoldViolationError;
      expect(e.conversationId).toBe("conv-1");
      expect(e.retentionClass).toBe("legal-hold");
      expect(e.attempted).toBe("delete");
    }
  });

  it("succeeds for retentionClass='standard-7y' (no regression)", async () => {
    const { container, batchSpy } = makeFakeContainerWithRoot(makeRoot("standard-7y"));
    __resetV2ContainerForTest(container);

    await expect(deleteConversationV2("conv-1", "owner-1")).resolves.toBeUndefined();
    expect(batchSpy).toHaveBeenCalled();
  });
});

describe("updateTitleV2 — direct legal-hold rejection", () => {
  it("throws LegalHoldViolationError with attempted='rename'", async () => {
    const { container, patchSpy } = makeFakeContainerWithRoot(makeRoot("legal-hold"));
    __resetV2ContainerForTest(container);

    await expect(updateTitleV2("conv-1", "owner-1", "New title")).rejects.toBeInstanceOf(
      LegalHoldViolationError,
    );

    expect(patchSpy).not.toHaveBeenCalled();

    try {
      await updateTitleV2("conv-1", "owner-1", "New title");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as LegalHoldViolationError;
      expect(e.attempted).toBe("rename");
      expect(e.retentionClass).toBe("legal-hold");
    }
  });

  it("succeeds for retentionClass='client-matter'", async () => {
    const { container, patchSpy } = makeFakeContainerWithRoot(makeRoot("client-matter"));
    __resetV2ContainerForTest(container);

    await expect(updateTitleV2("conv-1", "owner-1", "New title")).resolves.toBeUndefined();
    expect(patchSpy).toHaveBeenCalled();
  });
});
