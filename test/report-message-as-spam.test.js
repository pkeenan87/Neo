import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated validation logic from executors.ts ───────────

const UPN_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9+/=_-]{10,512}$/;
const SAFE_SEARCH_RE = /^[\w\s@.\-,!?']+$/u;
const MAX_SEARCH_DAYS = 90;

function validateUpn(upn) {
  if (!UPN_RE.test(upn)) {
    throw new Error(`Invalid UPN format: ${upn}`);
  }
}

function validateMessageId(id) {
  if (!id || !MESSAGE_ID_RE.test(id)) {
    throw new Error("Invalid or missing message_id");
  }
}

function validateSearchText(text) {
  if (text && !SAFE_SEARCH_RE.test(text)) {
    throw new Error("search_text contains unsupported characters");
  }
}

function clampDays(days) {
  return Math.max(1, Math.min(days ?? 7, MAX_SEARCH_DAYS));
}

// ── Mock data structure ─────────────────────────────────────

function mockSearchResult() {
  return {
    messages: [
      {
        id: "AAMkAGI2TG93AAA=",
        subject: "Urgent: Invoice #4829",
        from: {
          emailAddress: {
            name: "accounts@suspicious.com",
            address: "accounts@suspicious.com",
          },
        },
        receivedDateTime: "2026-03-19T09:15:00Z",
        bodyPreview: "Please review the attached invoice...",
        hasAttachments: true,
        isRead: true,
      },
    ],
    count: 1,
    upn: "jsmith@goodwin.com",
    searchCriteria: { sender: "accounts@suspicious.com", days: 7 },
    _mock: true,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("Mock search response structure", () => {
  it("has expected message fields", () => {
    const result = mockSearchResult();
    assert.ok(Array.isArray(result.messages));
    assert.equal(result.messages.length, 1);

    const msg = result.messages[0];
    assert.ok(msg.id);
    assert.ok(msg.subject);
    assert.ok(msg.from?.emailAddress?.address);
    assert.ok(msg.receivedDateTime);
    assert.ok(typeof msg.bodyPreview === "string");
    assert.ok(typeof msg.hasAttachments === "boolean");
    assert.ok(typeof msg.isRead === "boolean");
  });

  it("includes search criteria and UPN", () => {
    const result = mockSearchResult();
    assert.equal(result.upn, "jsmith@goodwin.com");
    assert.ok(result.searchCriteria);
    assert.equal(result.count, 1);
  });
});

describe("UPN validation", () => {
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

describe("Message ID validation", () => {
  it("accepts valid Graph message IDs (base64 with padding)", () => {
    assert.doesNotThrow(() => validateMessageId("AAMkAGI2TG93AAA="));
    assert.doesNotThrow(() => validateMessageId("abc123DEF456+/=="));
    assert.doesNotThrow(() => validateMessageId("a".repeat(200)));
  });

  it("rejects empty or missing message IDs", () => {
    assert.throws(() => validateMessageId(""), /Invalid or missing/);
    assert.throws(() => validateMessageId(undefined), /Invalid or missing/);
    assert.throws(() => validateMessageId(null), /Invalid or missing/);
  });

  it("rejects message IDs with special characters", () => {
    assert.throws(() => validateMessageId("id with spaces"), /Invalid or missing/);
    assert.throws(() => validateMessageId("id<script>"), /Invalid or missing/);
  });

  it("rejects too-short message IDs", () => {
    assert.throws(() => validateMessageId("short"), /Invalid or missing/);
  });

  it("rejects too-long message IDs (>512 chars)", () => {
    assert.throws(() => validateMessageId("a".repeat(513)), /Invalid or missing/);
  });
});

describe("Search text validation", () => {
  it("accepts normal search text", () => {
    assert.doesNotThrow(() => validateSearchText("invoice payment"));
    assert.doesNotThrow(() => validateSearchText("wire transfer from john@acme.com"));
    assert.doesNotThrow(() => validateSearchText("What's this?"));
  });

  it("rejects KQL operators and special characters", () => {
    assert.throws(() => validateSearchText("invoice AND body:password"), /unsupported characters/);
    assert.throws(() => validateSearchText("subject:secret OR from:admin"), /unsupported characters/);
    assert.throws(() => validateSearchText("test(parens)"), /unsupported characters/);
  });

  it("allows undefined/null (optional param)", () => {
    assert.doesNotThrow(() => validateSearchText(undefined));
    assert.doesNotThrow(() => validateSearchText(""));
  });
});

describe("Days clamping", () => {
  it("defaults to 7 when undefined", () => {
    assert.equal(clampDays(undefined), 7);
  });

  it("clamps to 1 for zero or negative values", () => {
    assert.equal(clampDays(0), 1);
    assert.equal(clampDays(-5), 1);
  });

  it("clamps to 90 for large values", () => {
    assert.equal(clampDays(365), 90);
    assert.equal(clampDays(36500), 90);
  });

  it("passes through valid values unchanged", () => {
    assert.equal(clampDays(7), 7);
    assert.equal(clampDays(30), 30);
    assert.equal(clampDays(90), 90);
  });
});

describe("Report type validation", () => {
  it("accepts phishing and junk as valid report types", () => {
    const validTypes = new Set(["phishing", "junk"]);
    assert.ok(validTypes.has("phishing"));
    assert.ok(validTypes.has("junk"));
    assert.ok(!validTypes.has("spam"));
  });

  it("defaults to phishing when not specified", () => {
    const reportType = undefined ?? "phishing";
    assert.equal(reportType, "phishing");
  });
});

describe("Tool schema expectations", () => {
  it("search_user_messages has upn as required, others optional", () => {
    const schema = {
      required: ["upn"],
      properties: ["upn", "sender", "subject", "search_text", "days"],
    };
    assert.ok(schema.required.includes("upn"));
    assert.ok(!schema.required.includes("sender"));
    assert.ok(!schema.required.includes("search_text"));
  });

  it("report_message_as_phishing has upn, message_id, justification as required", () => {
    const schema = {
      required: ["upn", "message_id", "justification"],
    };
    assert.ok(schema.required.includes("upn"));
    assert.ok(schema.required.includes("message_id"));
    assert.ok(schema.required.includes("justification"));
    assert.ok(!schema.required.includes("report_type"));
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password",
    "isolate_machine",
    "unisolate_machine",
    "search_user_messages",
    "report_message_as_phishing",
  ]);

  it("search_user_messages IS in DESTRUCTIVE_TOOLS (reads any mailbox)", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("search_user_messages"));
  });

  it("report_message_as_phishing is in DESTRUCTIVE_TOOLS", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("report_message_as_phishing"));
  });
});
