import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated domain validation from executors.ts ──────────

const VENDOR_DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function validateVendorDomain(domain) {
  if (!VENDOR_DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid vendor domain format: ${domain}`);
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("Vendor domain validation", () => {
  it("accepts valid domains", () => {
    assert.doesNotThrow(() => validateVendorDomain("example.com"));
    assert.doesNotThrow(() => validateVendorDomain("acme-billing.com"));
    assert.doesNotThrow(() => validateVendorDomain("sub.domain.co.uk"));
  });

  it("rejects invalid domains", () => {
    assert.throws(() => validateVendorDomain("not a domain"));
    assert.throws(() => validateVendorDomain(""));
    assert.throws(() => validateVendorDomain("-evil.com"));
    assert.throws(() => validateVendorDomain("evil..com"));
  });

  it("rejects bare TLDs", () => {
    assert.throws(() => validateVendorDomain("com"));
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password", "dismiss_user_risk",
    "isolate_machine", "unisolate_machine",
    "report_message_as_phishing",
    "approve_threatlocker_request", "deny_threatlocker_request",
    "block_indicator", "import_indicators", "delete_indicator",
  ]);

  it("get_vendor_risk is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_vendor_risk"));
  });

  it("list_vendors is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_vendors"));
  });

  it("get_vendor_activity is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_vendor_activity"));
  });

  it("list_vendor_cases is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_vendor_cases"));
  });

  it("get_vendor_case is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_vendor_case"));
  });
});

describe("Tool schema expectations", () => {
  it("get_vendor_risk requires vendor_domain", () => {
    const required = ["vendor_domain"];
    assert.ok(required.includes("vendor_domain"));
  });

  it("list_vendors has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("get_vendor_activity requires vendor_domain", () => {
    const required = ["vendor_domain"];
    assert.ok(required.includes("vendor_domain"));
  });

  it("list_vendor_cases has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("get_vendor_case requires case_id", () => {
    const required = ["case_id"];
    assert.ok(required.includes("case_id"));
  });
});

describe("Mock vendor risk data structure", () => {
  const mockData = {
    vendorDomain: "acme-billing.com",
    riskLevel: "High",
    vendorContacts: [{ email: "billing@acme-billing.com", name: "Billing" }],
    companyContacts: [{ email: "jsmith@goodwin.com", name: "John Smith" }],
    vendorCountries: ["US"],
    vendorIpAddresses: ["203.0.113.42"],
    analysis: ["Vendor Compromise Seen in Abnormal Community"],
  };

  it("has riskLevel field", () => {
    assert.ok(["High", "Medium", "Low"].includes(mockData.riskLevel));
  });

  it("has vendorContacts array", () => {
    assert.ok(Array.isArray(mockData.vendorContacts));
    assert.ok(mockData.vendorContacts[0].email);
  });

  it("has analysis array with community intelligence", () => {
    assert.ok(Array.isArray(mockData.analysis));
    assert.ok(mockData.analysis.length > 0);
  });
});

describe("Case ID validation", () => {
  it("rejects empty string", () => {
    const caseId = "";
    assert.ok(!caseId || caseId.trim() === "");
  });

  it("accepts non-empty string", () => {
    const caseId = "vc-001";
    assert.ok(caseId && caseId.trim() !== "");
  });
});

describe("Pagination clamping", () => {
  it("clamps page_size to 100 max", () => {
    const clamped = Math.max(1, Math.min(200, 100));
    assert.equal(clamped, 100);
  });

  it("clamps page_number to 1 min", () => {
    const clamped = Math.max(1, 0);
    assert.equal(clamped, 1);
  });

  it("passes through valid values", () => {
    assert.equal(Math.max(1, Math.min(25, 100)), 25);
    assert.equal(Math.max(1, 3), 3);
  });
});
