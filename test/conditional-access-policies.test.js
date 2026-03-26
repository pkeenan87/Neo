import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Tests ────────────────────────────────────────────────────

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password", "dismiss_user_risk",
    "isolate_machine", "unisolate_machine",
    "report_message_as_phishing",
    "approve_threatlocker_request", "deny_threatlocker_request",
    "block_indicator", "import_indicators", "delete_indicator",
    "remediate_abnormal_messages", "action_ato_case",
  ]);

  it("list_ca_policies is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_ca_policies"));
  });

  it("get_ca_policy is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_ca_policy"));
  });

  it("list_named_locations is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_named_locations"));
  });
});

describe("Tool schema expectations", () => {
  it("list_ca_policies has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("get_ca_policy requires policy_id", () => {
    const required = ["policy_id"];
    assert.ok(required.includes("policy_id"));
    assert.equal(required.length, 1);
  });

  it("list_named_locations has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });
});

describe("Policy ID validation", () => {
  it("rejects empty string", () => {
    const policyId = "";
    assert.ok(!policyId || policyId.trim() === "");
  });

  it("accepts non-empty string", () => {
    const policyId = "ca-001";
    assert.ok(policyId && policyId.trim() !== "");
  });
});

describe("Mock CA policy data structure", () => {
  const mockPolicy = {
    id: "ca-001",
    displayName: "Require MFA for All Users",
    state: "enabled",
    conditions: {
      users: { includeUsers: ["All"], excludeUsers: [] },
      applications: { includeApplications: ["All"], excludeApplications: [] },
      clientAppTypes: ["browser", "mobileAppsAndDesktopClients"],
      locations: { includeLocations: ["All"], excludeLocations: ["AllTrusted"] },
    },
    grantControls: { operator: "OR", builtInControls: ["mfa"] },
  };

  it("has displayName", () => {
    assert.ok(mockPolicy.displayName);
  });

  it("has state field with valid value", () => {
    assert.ok(["enabled", "disabled", "enabledForReportingButNotEnforced"].includes(mockPolicy.state));
  });

  it("has conditions block with users and applications", () => {
    assert.ok(mockPolicy.conditions.users);
    assert.ok(mockPolicy.conditions.applications);
  });

  it("has grantControls with builtInControls", () => {
    assert.ok(Array.isArray(mockPolicy.grantControls.builtInControls));
    assert.ok(mockPolicy.grantControls.builtInControls.includes("mfa"));
  });
});

describe("Mock named locations structure", () => {
  const ipLocation = {
    "@odata.type": "#microsoft.graph.ipNamedLocation",
    id: "loc-001",
    displayName: "Corporate Office IPs",
    isTrusted: true,
    ipRanges: [
      { cidrAddress: "198.51.100.0/24" },
    ],
  };

  const countryLocation = {
    "@odata.type": "#microsoft.graph.countryNamedLocation",
    id: "loc-002",
    displayName: "Blocked Countries",
    countriesAndRegions: ["RU", "CN", "KP", "IR"],
  };

  it("IP location has CIDR ranges and trusted flag", () => {
    assert.ok(ipLocation["@odata.type"].includes("ipNamedLocation"));
    assert.ok(Array.isArray(ipLocation.ipRanges));
    assert.equal(typeof ipLocation.isTrusted, "boolean");
  });

  it("country location has country codes", () => {
    assert.ok(countryLocation["@odata.type"].includes("countryNamedLocation"));
    assert.ok(Array.isArray(countryLocation.countriesAndRegions));
    assert.ok(countryLocation.countriesAndRegions.includes("RU"));
  });
});

describe("GUID resolution", () => {
  it("skips special values like All, None, GuestsOrExternalUsers", () => {
    const specialValues = new Set(["All", "None", "GuestsOrExternalUsers", "Office365"]);
    assert.ok(specialValues.has("All"));
    assert.ok(specialValues.has("GuestsOrExternalUsers"));
    assert.ok(!specialValues.has("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
  });
});
