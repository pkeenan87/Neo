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
    getSkill: (id: string) => skills[id] ?? undefined,
  };
});

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
  it("resolves a mapped product:alertType to the correct skill", () => {
    const result = resolveTriageSkill(makeSource());
    expect(result).not.toBeNull();
    expect(result!.skillId).toBe("defender-endpoint-triage");
    expect(result!.skill.name).toBe("Defender Endpoint Triage");
  });

  it("falls back to the generic catch-all for unmapped alert types", () => {
    const result = resolveTriageSkill(makeSource({
      product: "Sentinel",
      alertType: "Unknown.AlertType",
    }));
    expect(result).not.toBeNull();
    expect(result!.skillId).toBe("generic-alert-triage");
  });

  it("falls back to catch-all when the mapped skill ID is not registered", () => {
    // DefenderXDR:SomeOtherType is not in TRIAGE_SKILL_MAP
    const result = resolveTriageSkill(makeSource({
      alertType: "SomeOtherType",
    }));
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
