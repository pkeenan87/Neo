import { describe, it, expect, beforeEach, vi } from "vitest";

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

// Force Cosmos-mode for this test file. vi.hoisted runs BEFORE the
// hoisted import block, so skill-store.ts evaluates `useCosmos()`
// against the patched env.
vi.hoisted(() => {
  process.env.COSMOS_ENDPOINT = "https://mock.documents.azure.com:443/";
  process.env.MOCK_MODE = "false";
});

// Mock TOOLS so validateSkill doesn't reject a synthetic test skill.
// ALL_TOOL_NAMES must include both the mocked custom-tool names AND any
// server tools the skill-parser layer expects to recognise — it now
// uses ALL_TOOL_NAMES instead of rebuilding the set from TOOLS, so
// stubbing TOOLS alone is no longer sufficient.
vi.mock("../lib/tools", () => ({
  TOOLS: [{ name: "run_sentinel_kql" }, { name: "get_user_info" }],
  SERVER_TOOLS: [],
  DESTRUCTIVE_TOOLS: new Set<string>(),
  ALL_TOOL_NAMES: new Set<string>(["run_sentinel_kql", "get_user_info"]),
}));

interface Stored {
  resource: Record<string, unknown>;
}
function makeFakeContainer() {
  const store = new Map<string, Stored>();
  return {
    container: {
      items: {
        async create<T extends { id: string }>(doc: T): Promise<{ resource: T }> {
          if (store.has(doc.id)) {
            throw Object.assign(new Error("conflict"), { code: 409 });
          }
          store.set(doc.id, { resource: doc as unknown as Record<string, unknown> });
          return { resource: doc };
        },
        async upsert<T extends { id: string }>(doc: T): Promise<{ resource: T }> {
          store.set(doc.id, { resource: doc as unknown as Record<string, unknown> });
          return { resource: doc };
        },
        query<T>(_q: unknown) {
          return {
            async fetchAll(): Promise<{ resources: T[] }> {
              return { resources: Array.from(store.values()).map((s) => s.resource as unknown as T) };
            },
          };
        },
      },
      item(id: string, _pk: string) {
        return {
          async read<T>() {
            const entry = store.get(id);
            return entry
              ? { resource: entry.resource as unknown as T, etag: "e" }
              : { resource: undefined, etag: undefined };
          },
          async delete() {
            store.delete(id);
            return { code: 204 };
          },
        };
      },
    },
    store,
  };
}

import {
  __setContainerForTest as setSkillCosmosContainer,
} from "../lib/skill-store-cosmos";
import {
  getSkill,
  getAllSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  __invalidateCosmosCacheForTest,
} from "../lib/skill-store";

const SKILL_MD = `# Skill: Test Skill

## Description
A skill for tests.

## Required Tools
- run_sentinel_kql

## Required Role
reader

## Steps
1. do a thing
`;

describe("skill-store dual-source — Cosmos mode", () => {
  beforeEach(() => {
    const fake = makeFakeContainer();
    setSkillCosmosContainer(fake.container as never);
    __invalidateCosmosCacheForTest();
  });

  it("createSkill writes to Cosmos and is readable via getSkill", async () => {
    await createSkill("test-skill", SKILL_MD);
    const got = await getSkill("test-skill");
    expect(got).toBeDefined();
    expect(got!.name).toBe("Test Skill");
  });

  it("getAllSkills returns the Cosmos-backed list", async () => {
    await createSkill("test-skill", SKILL_MD);
    await createSkill("another", SKILL_MD.replace("Test Skill", "Another"));
    const all = await getAllSkills();
    expect(all.map((s) => s.id).sort()).toEqual(["another", "test-skill"]);
  });

  it("updateSkill replaces an existing entry; cache invalidated", async () => {
    await createSkill("test-skill", SKILL_MD);
    await updateSkill("test-skill", SKILL_MD.replace("A skill for tests.", "Updated description."));
    const got = await getSkill("test-skill");
    expect(got!.description).toBe("Updated description.");
  });

  it("deleteSkill removes the doc from Cosmos", async () => {
    await createSkill("test-skill", SKILL_MD);
    await deleteSkill("test-skill");
    const got = await getSkill("test-skill");
    expect(got).toBeUndefined();
  });

  it("createSkill rejects duplicates", async () => {
    await createSkill("test-skill", SKILL_MD);
    await expect(createSkill("test-skill", SKILL_MD)).rejects.toThrow(/already exists/);
  });

  it("updateSkill throws when the id doesn't exist", async () => {
    await expect(updateSkill("nope", SKILL_MD)).rejects.toThrow(/not found/);
  });
});
