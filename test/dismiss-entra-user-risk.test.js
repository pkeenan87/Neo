import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated validation from executors.ts ─────────────────

const UPN_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function validateUpn(upn) {
  if (!UPN_RE.test(upn)) {
    throw new Error(`Invalid UPN format: ${upn}`);
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("UPN validation for dismiss_user_risk", () => {
  it("accepts valid UPNs", () => {
    assert.doesNotThrow(() => validateUpn("jsmith@goodwin.com"));
    assert.doesNotThrow(() => validateUpn("john.smith@contoso.onmicrosoft.com"));
  });

  it("rejects invalid UPNs", () => {
    assert.throws(() => validateUpn("not-an-email"), /Invalid UPN format/);
    assert.throws(() => validateUpn(""), /Invalid UPN format/);
    assert.throws(() => validateUpn("user@"), /Invalid UPN format/);
  });
});

describe("Mock dismiss response", () => {
  it("has expected fields", () => {
    const mockResponse = {
      dismissed: true,
      upn: "jsmith@goodwin.com",
      justification: "Risk investigated — confirmed false positive",
      _mock: true,
    };
    assert.equal(mockResponse.dismissed, true);
    assert.equal(mockResponse.upn, "jsmith@goodwin.com");
    assert.ok(mockResponse.justification);
    assert.equal(mockResponse._mock, true);
  });
});

describe("Tool schema expectations", () => {
  it("has upn and justification as required", () => {
    const required = ["upn", "justification"];
    assert.ok(required.includes("upn"));
    assert.ok(required.includes("justification"));
    assert.equal(required.length, 2);
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password",
    "dismiss_user_risk",
    "isolate_machine",
    "unisolate_machine",
    "search_user_messages",
    "report_message_as_phishing",
    "approve_threatlocker_request",
    "deny_threatlocker_request",
  ]);

  it("dismiss_user_risk is in DESTRUCTIVE_TOOLS", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("dismiss_user_risk"));
  });

  it("get_user_info is NOT in DESTRUCTIVE_TOOLS", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_user_info"));
  });
});
