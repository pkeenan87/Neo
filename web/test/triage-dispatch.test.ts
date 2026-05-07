import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/skill-store", () => {
  const skills: Record<string, unknown> = {
    "defender-endpoint-triage": {
      id: "defender-endpoint-triage",
      name: "Defender Endpoint Triage",
      instructions: "investigate endpoint alert",
      requiredTools: ["get_xdr_alert", "search_xdr_by_host"],
      requiredRole: "reader",
    },
    "generic-alert-triage": {
      id: "generic-alert-triage",
      name: "Generic Alert Triage",
      instructions: "investigate generic alert",
      requiredTools: ["run_sentinel_kql", "get_user_info"],
      requiredRole: "reader",
    },
  };
  return {
    getSkill: async (id: string) => skills[id] ?? undefined,
  };
});

// Mockable mapping table — tests mutate `mappingState` to reshape
// what `getMapping(key)` returns. `mappingThrows` simulates a Cosmos
// outage so the dispatch fallback path can be exercised.
let mappingThrows = false;
let mappingState: Record<string, { id: string; skillId: string; updatedAt: string; updatedBy: string } | undefined> = {};
vi.mock("../lib/triage-mapping-store", () => ({
  getMapping: async (key: string) => {
    if (mappingThrows) throw new Error("simulated Cosmos failure");
    return mappingState[key];
  },
}));

let callerAllowlistValue = "";
vi.mock("../lib/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/config");
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === "TRIAGE_CALLER_ALLOWLIST") return callerAllowlistValue;
        return target[prop as string];
      },
    }),
  };
});

import { resolveTriageSkill, checkCallerAllowlist } from "../lib/triage-dispatch";
import type { TriageSource } from "../lib/types";

function makeSource(overrides: Partial<TriageSource> = {}): TriageSource {
  return {
    product: "DefenderXDR",
    alertType: "DefenderEndpoint.SuspiciousProcess",
    severity: "Medium",
    tenantId: "test-tenant",
    alertId: "alert-001",
    detectionTime: "2026-04-12T00:00:00Z",
    ...overrides,
  };
}

describe("resolveTriageSkill", () => {
  beforeEach(() => {
    mappingThrows = false;
    mappingState = {
      "DefenderXDR:DefenderEndpoint.SuspiciousProcess": {
        id: "DefenderXDR:DefenderEndpoint.SuspiciousProcess",
        skillId: "defender-endpoint-triage",
        updatedAt: "2026-05-07T00:00:00.000Z",
        updatedBy: "test",
      },
    };
  });

  it("resolves a mapped product:alertType to the correct skill", async () => {
    const result = await resolveTriageSkill(makeSource());
    expect(result).not.toBeNull();
    expect(result!.skillId).toBe("defender-endpoint-triage");
    expect(result!.skill.name).toBe("Defender Endpoint Triage");
  });

  it("falls back to the generic catch-all for unmapped alert types", async () => {
    const result = await resolveTriageSkill(makeSource({
      product: "Sentinel",
      alertType: "Unknown.AlertType",
    }));
    expect(result).not.toBeNull();
    expect(result!.skillId).toBe("generic-alert-triage");
  });

  it("falls back to catch-all when the mapped skill ID is not registered", async () => {
    // Mapping points at a skill that no longer exists in the skill
    // store — the orphan path. Should treat as a miss + warn + use
    // the generic skill.
    mappingState = {
      "DefenderXDR:DefenderEndpoint.SuspiciousProcess": {
        id: "DefenderXDR:DefenderEndpoint.SuspiciousProcess",
        skillId: "deleted-skill-id",
        updatedAt: "2026-05-07T00:00:00.000Z",
        updatedBy: "test",
      },
    };
    const result = await resolveTriageSkill(makeSource());
    expect(result).not.toBeNull();
    expect(result!.skillId).toBe("generic-alert-triage");
  });

  it("falls back to the generic skill when the mapping store throws (Cosmos outage)", async () => {
    mappingThrows = true;
    const result = await resolveTriageSkill(makeSource());
    expect(result).not.toBeNull();
    expect(result!.skillId).toBe("generic-alert-triage");
  });
});

describe("checkCallerAllowlist", () => {
  it("allows all callers when the allowlist is empty", () => {
    callerAllowlistValue = "";
    expect(checkCallerAllowlist("any-app-id", "defender-endpoint-triage")).toBe(true);
  });

  it("allows a caller with a matching skill in their list", () => {
    callerAllowlistValue = "app-001:defender-endpoint-triage,generic-alert-triage";
    expect(checkCallerAllowlist("app-001", "defender-endpoint-triage")).toBe(true);
  });

  it("blocks a caller whose skill is not in their list", () => {
    callerAllowlistValue = "app-001:generic-alert-triage";
    expect(checkCallerAllowlist("app-001", "defender-endpoint-triage")).toBe(false);
  });

  it("allows a caller with a wildcard (*) in their list", () => {
    callerAllowlistValue = "app-001:*";
    expect(checkCallerAllowlist("app-001", "defender-endpoint-triage")).toBe(true);
    expect(checkCallerAllowlist("app-001", "any-other-skill")).toBe(true);
  });

  it("blocks a caller not listed in a non-empty allowlist", () => {
    callerAllowlistValue = "app-001:*";
    expect(checkCallerAllowlist("app-999", "defender-endpoint-triage")).toBe(false);
  });

  it("supports multiple callers separated by semicolons", () => {
    callerAllowlistValue = "app-001:defender-endpoint-triage;app-002:generic-alert-triage";
    expect(checkCallerAllowlist("app-001", "defender-endpoint-triage")).toBe(true);
    expect(checkCallerAllowlist("app-002", "generic-alert-triage")).toBe(true);
    expect(checkCallerAllowlist("app-001", "generic-alert-triage")).toBe(false);
  });
});
