import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted in-memory state stand-in for the Cosmos container. Each
// test resets it via afterEach so cross-test bleed is impossible.
const cosmosState = {
  store: new Map<string, { id: string; skillId: string; updatedAt: string; updatedBy: string }>(),
  shouldThrow: false,
};

vi.mock("../lib/triage-mapping-store-cosmos", () => ({
  listMappingsFromCosmos: async () => {
    if (cosmosState.shouldThrow) throw new Error("simulated Cosmos failure");
    return Array.from(cosmosState.store.values());
  },
  getMappingFromCosmos: async (id: string) => {
    if (cosmosState.shouldThrow) throw new Error("simulated Cosmos failure");
    return cosmosState.store.get(id);
  },
  createMappingInCosmos: async (mapping: { id: string }) => {
    if (cosmosState.store.has(mapping.id)) {
      throw new Error(`Triage mapping for "${mapping.id}" already exists`);
    }
    cosmosState.store.set(mapping.id, mapping as never);
  },
  upsertMappingInCosmos: async (mapping: { id: string }) => {
    cosmosState.store.set(mapping.id, mapping as never);
  },
  deleteMappingFromCosmos: async (id: string) => {
    cosmosState.store.delete(id);
  },
  __setContainerForTest: () => undefined,
}));

import {
  getAllMappings,
  getMapping,
  getMappingsForSkill,
  createMapping,
  updateMapping,
  deleteMapping,
  validateMappingKey,
  __invalidateCacheForTest,
  legacyDefaultMapping,
  TRIAGE_MAPPING_CACHE_TTL_MS,
} from "../lib/triage-mapping-store";

const ID = { ownerIdHash: "test-admin" };

beforeEach(() => {
  cosmosState.store.clear();
  cosmosState.shouldThrow = false;
  __invalidateCacheForTest();
});

afterEach(() => {
  // Make sure no test leaks the Cosmos toggle.
  process.env.COSMOS_ENDPOINT = undefined;
  process.env.MOCK_MODE = undefined;
});

// ── Validation ───────────────────────────────────────────────

describe("validateMappingKey", () => {
  it("accepts canonical product:alertType keys", () => {
    expect(validateMappingKey("DefenderXDR:DefenderEndpoint.SuspiciousProcess")).toBeNull();
    expect(validateMappingKey("Sentinel:HighSeverity")).toBeNull();
    expect(validateMappingKey("EntraIDProtection:RiskySignIn")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(validateMappingKey("")).toMatch(/required/);
  });

  it("rejects keys without exactly one colon", () => {
    expect(validateMappingKey("nocolon")).toMatch(/exactly one ':' separator/);
    expect(validateMappingKey("two:colons:here")).toMatch(/exactly one ':' separator/);
  });

  it("rejects keys with whitespace", () => {
    expect(validateMappingKey("Defender XDR:Foo")).toMatch(/whitespace/);
    expect(validateMappingKey("DefenderXDR:Foo Bar")).toMatch(/whitespace/);
  });

  it("rejects empty halves", () => {
    expect(validateMappingKey(":Foo")).not.toBeNull();
    expect(validateMappingKey("Foo:")).not.toBeNull();
  });

  it("rejects unsupported special characters", () => {
    expect(validateMappingKey("DefenderXDR:Foo/Bar")).toMatch(/alphanumeric/);
    expect(validateMappingKey("DefenderXDR:Foo!Bar")).toMatch(/alphanumeric/);
  });

  it("is case-sensitive — both casings are valid as separate keys", () => {
    // Validation only checks shape, not uniqueness across casings.
    expect(validateMappingKey("DefenderXDR:Foo")).toBeNull();
    expect(validateMappingKey("defenderxdr:foo")).toBeNull();
  });
});

// ── Mock-mode behaviour (default — Cosmos disabled) ─────────

describe("triage-mapping-store — mock mode (no Cosmos)", () => {
  // Mock mode is active when COSMOS_ENDPOINT is unset or MOCK_MODE !== "false".
  // beforeEach clears the env vars so we start in mock mode.

  it("seeds the in-memory store with the legacy default mapping", async () => {
    const all = await getAllMappings();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("DefenderXDR:DefenderEndpoint.SuspiciousProcess");
    expect(all[0].skillId).toBe("defender-endpoint-triage");
  });

  it("getMapping returns the seeded entry by exact key", async () => {
    const mapping = await getMapping("DefenderXDR:DefenderEndpoint.SuspiciousProcess");
    expect(mapping).toBeDefined();
    expect(mapping!.skillId).toBe("defender-endpoint-triage");
  });

  it("getMapping is case-sensitive", async () => {
    const mapping = await getMapping("defenderxdr:defenderendpoint.suspiciousprocess");
    expect(mapping).toBeUndefined();
  });

  it("createMapping adds a new entry", async () => {
    const created = await createMapping("Sentinel:HighSeverity", "defender-endpoint-triage", ID);
    expect(created.id).toBe("Sentinel:HighSeverity");
    expect(created.skillId).toBe("defender-endpoint-triage");
    expect(created.updatedBy).toBe(ID.ownerIdHash);

    const all = await getAllMappings();
    expect(all).toHaveLength(2);
  });

  it("createMapping rejects duplicates", async () => {
    await expect(
      createMapping(
        "DefenderXDR:DefenderEndpoint.SuspiciousProcess",
        "defender-endpoint-triage",
        ID,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("createMapping rejects an invalid key shape", async () => {
    await expect(createMapping("nocolon", "x", ID)).rejects.toThrow(/separator/);
  });

  it("updateMapping changes the skillId for an existing key", async () => {
    const updated = await updateMapping(
      "DefenderXDR:DefenderEndpoint.SuspiciousProcess",
      "generic-alert-triage",
      ID,
    );
    expect(updated.skillId).toBe("generic-alert-triage");
    const fetched = await getMapping("DefenderXDR:DefenderEndpoint.SuspiciousProcess");
    expect(fetched!.skillId).toBe("generic-alert-triage");
  });

  it("updateMapping rejects keys that don't exist", async () => {
    await expect(
      updateMapping("Sentinel:Missing", "anything", ID),
    ).rejects.toThrow(/not found/);
  });

  it("deleteMapping removes the entry", async () => {
    await deleteMapping("DefenderXDR:DefenderEndpoint.SuspiciousProcess");
    const all = await getAllMappings();
    expect(all).toHaveLength(0);
  });

  it("deleteMapping is idempotent on a missing key", async () => {
    await expect(
      deleteMapping("Sentinel:Missing"),
    ).resolves.not.toThrow();
  });

  it("getMappingsForSkill returns every mapping pointed at the skill", async () => {
    await createMapping("Sentinel:Foo", "defender-endpoint-triage", ID);
    await createMapping("Sentinel:Bar", "generic-alert-triage", ID);

    const defender = await getMappingsForSkill("defender-endpoint-triage");
    expect(defender.map((m) => m.id).sort()).toEqual([
      "DefenderXDR:DefenderEndpoint.SuspiciousProcess",
      "Sentinel:Foo",
    ]);

    const generic = await getMappingsForSkill("generic-alert-triage");
    expect(generic.map((m) => m.id)).toEqual(["Sentinel:Bar"]);
  });
});

// ── Cosmos-mode behaviour (read-through cache, atomic create) ─

describe("triage-mapping-store — Cosmos mode", () => {
  beforeEach(() => {
    process.env.COSMOS_ENDPOINT = "https://fake.documents.azure.com:443/";
    process.env.MOCK_MODE = "false";
    cosmosState.store.clear();
    cosmosState.shouldThrow = false;
    __invalidateCacheForTest();
  });

  it("listMappings returns whatever Cosmos has", async () => {
    cosmosState.store.set("DefenderXDR:Foo", {
      id: "DefenderXDR:Foo",
      skillId: "defender-endpoint-triage",
      updatedAt: "2026-05-07T00:00:00.000Z",
      updatedBy: "x",
    });
    const all = await getAllMappings();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("DefenderXDR:Foo");
  });

  it("createMapping persists through to Cosmos and invalidates the cache", async () => {
    await createMapping("Sentinel:NewMapping", "defender-endpoint-triage", ID);
    expect(cosmosState.store.has("Sentinel:NewMapping")).toBe(true);

    // First read after a write should reflect the new entry on the
    // next refresh — invalidation happens inside createMapping.
    const fetched = await getMapping("Sentinel:NewMapping");
    expect(fetched).toBeDefined();
  });

  it("createMapping surfaces a duplicate-create as an 'already exists' Error", async () => {
    cosmosState.store.set("DefenderXDR:Foo", {
      id: "DefenderXDR:Foo",
      skillId: "defender-endpoint-triage",
      updatedAt: "2026-05-07T00:00:00.000Z",
      updatedBy: "x",
    });
    await expect(
      createMapping("DefenderXDR:Foo", "defender-endpoint-triage", ID),
    ).rejects.toThrow(/already exists/);
  });

  it("updateMapping refuses to update a key Cosmos doesn't know about", async () => {
    await expect(
      updateMapping("Sentinel:Missing", "x", ID),
    ).rejects.toThrow(/not found/);
  });

  it("read-through cache returns the same data within the TTL window", async () => {
    cosmosState.store.set("DefenderXDR:Foo", {
      id: "DefenderXDR:Foo",
      skillId: "defender-endpoint-triage",
      updatedAt: "2026-05-07T00:00:00.000Z",
      updatedBy: "x",
    });
    const first = await getAllMappings();
    expect(first).toHaveLength(1);

    // Mutate cosmos directly without going through the store —
    // the cache should still be warm and return the stale view.
    cosmosState.store.set("Sentinel:Bar", {
      id: "Sentinel:Bar",
      skillId: "generic-alert-triage",
      updatedAt: "2026-05-07T00:00:00.000Z",
      updatedBy: "x",
    });
    const second = await getAllMappings();
    expect(second).toHaveLength(1);

    // Force a refresh and confirm the new entry shows up.
    __invalidateCacheForTest();
    const third = await getAllMappings();
    expect(third).toHaveLength(2);
  });
});

// ── Misc constants + helpers ─────────────────────────────────

describe("triage-mapping-store — exports", () => {
  it("exposes a 15-second cache TTL", () => {
    expect(TRIAGE_MAPPING_CACHE_TTL_MS).toBe(15 * 1000);
  });

  it("legacyDefaultMapping returns the documented Defender entry", () => {
    const seed = legacyDefaultMapping();
    expect(seed.id).toBe("DefenderXDR:DefenderEndpoint.SuspiciousProcess");
    expect(seed.skillId).toBe("defender-endpoint-triage");
  });
});
