import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import production helpers — tests validate the real code, not copies.
import {
  validateMd5Hash,
  validateSenderEmail,
  validateSenderIp,
  validateBodyLink,
  validateActivityLogId,
  defaultTimeRange,
  validateRemediateInput,
} from "../web/lib/abnormal-helpers.ts";

// ── Tests ────────────────────────────────────────────────────

describe("MD5 hash validation", () => {
  it("accepts valid 32-char lowercase hex", () => {
    assert.equal(validateMd5Hash("d41d8cd98f00b204e9800998ecf8427e"), true);
  });

  it("accepts valid 32-char uppercase hex", () => {
    assert.equal(validateMd5Hash("D41D8CD98F00B204E9800998ECF8427E"), true);
  });

  it("accepts mixed case", () => {
    assert.equal(validateMd5Hash("d41D8cd98F00b204E9800998ecF8427e"), true);
  });

  it("rejects empty string", () => {
    assert.equal(validateMd5Hash(""), false);
  });

  it("rejects too-short hash", () => {
    assert.equal(validateMd5Hash("d41d8cd98f00b204"), false);
  });

  it("rejects too-long hash", () => {
    assert.equal(validateMd5Hash("d41d8cd98f00b204e9800998ecf8427eaa"), false);
  });

  it("rejects non-hex characters", () => {
    assert.equal(validateMd5Hash("g41d8cd98f00b204e9800998ecf8427e"), false);
    assert.equal(validateMd5Hash("d41d8cd98f00b204e9800998ecf8427!"), false);
  });
});

describe("Default time range", () => {
  it("returns start_time and end_time as ISO strings", () => {
    const range = defaultTimeRange();
    assert.ok(typeof range.start_time === "string");
    assert.ok(typeof range.end_time === "string");
    // Both should parse as valid dates
    assert.ok(!isNaN(new Date(range.start_time).getTime()));
    assert.ok(!isNaN(new Date(range.end_time).getTime()));
  });

  it("start_time is approximately 48 hours before end_time", () => {
    const range = defaultTimeRange();
    const start = new Date(range.start_time).getTime();
    const end = new Date(range.end_time).getTime();
    const diffHours = (end - start) / (1000 * 60 * 60);
    // Allow 1 second tolerance
    assert.ok(diffHours >= 47.99 && diffHours <= 48.01, `Expected ~48h, got ${diffHours}h`);
  });
});

describe("Remediate input validation", () => {
  it("passes when messages array has entries", () => {
    assert.doesNotThrow(() =>
      validateRemediateInput({
        messages: [{ message_id: "msg-123", recipient_email: "user@example.com" }],
      })
    );
  });

  it("passes when remediate_all is true with search_filters", () => {
    assert.doesNotThrow(() =>
      validateRemediateInput({
        remediate_all: true,
        search_filters: { sender_email: "bad@evil.com" },
      })
    );
  });

  it("throws when messages is empty and remediate_all is false", () => {
    assert.throws(
      () => validateRemediateInput({ messages: [] }),
      /non-empty messages array/
    );
  });

  it("throws when messages is undefined and remediate_all is false", () => {
    assert.throws(
      () => validateRemediateInput({}),
      /non-empty messages array/
    );
  });

  it("throws when remediate_all is true but search_filters is missing", () => {
    assert.throws(
      () => validateRemediateInput({ remediate_all: true }),
      /search_filters/
    );
  });

  it("throws when remediate_all is true but search_filters is empty object", () => {
    assert.throws(
      () => validateRemediateInput({ remediate_all: true, search_filters: {} }),
      /search_filters/
    );
  });
});

describe("Sender email validation", () => {
  it("accepts valid emails", () => {
    assert.equal(validateSenderEmail("user@example.com"), true);
    assert.equal(validateSenderEmail("first.last@domain.co.uk"), true);
  });

  it("rejects invalid emails", () => {
    assert.equal(validateSenderEmail("not-an-email"), false);
    assert.equal(validateSenderEmail("@domain.com"), false);
    assert.equal(validateSenderEmail("user@"), false);
    assert.equal(validateSenderEmail(""), false);
  });
});

describe("Sender IP validation", () => {
  it("accepts valid IPv4", () => {
    assert.equal(validateSenderIp("10.0.1.42"), true);
    assert.equal(validateSenderIp("192.168.1.1"), true);
  });

  it("rejects invalid IPs", () => {
    assert.equal(validateSenderIp("not-an-ip"), false);
    assert.equal(validateSenderIp("10.0.1"), false);
    assert.equal(validateSenderIp(""), false);
  });
});

describe("Body link validation", () => {
  it("accepts http and https URLs", () => {
    assert.equal(validateBodyLink("https://example.com/path"), true);
    assert.equal(validateBodyLink("http://evil.com"), true);
  });

  it("rejects non-http schemes", () => {
    assert.equal(validateBodyLink("javascript:alert(1)"), false);
    assert.equal(validateBodyLink("file:///etc/passwd"), false);
    assert.equal(validateBodyLink("ftp://files.example.com"), false);
  });

  it("rejects invalid URLs", () => {
    assert.equal(validateBodyLink("not a url"), false);
    assert.equal(validateBodyLink(""), false);
  });
});

describe("Activity log ID validation", () => {
  it("accepts valid IDs", () => {
    assert.equal(validateActivityLogId("act-d4e5f6a7-b8c9-0123-def4-567890abcdef"), true);
    assert.equal(validateActivityLogId("abc123"), true);
  });

  it("rejects empty string", () => {
    assert.equal(validateActivityLogId(""), false);
  });

  it("rejects strings with special characters", () => {
    assert.equal(validateActivityLogId("../../../admin"), false);
    assert.equal(validateActivityLogId("id with spaces"), false);
  });
});

describe("Mock search response structure", () => {
  const mock = {
    total_count: 3,
    page_number: 1,
    messages: [
      {
        message_id: "msg-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        subject: "Urgent: Verify your account credentials",
        sender_email: "security-alert@evil-domain.com",
        recipient_email: "jsmith@goodwin.com",
        received_time: "2026-03-24T14:30:00Z",
        judgement: "attack",
      },
    ],
  };

  it("has messages array", () => {
    assert.ok(Array.isArray(mock.messages));
    assert.ok(mock.messages.length > 0);
  });

  it("has total_count as number", () => {
    assert.ok(typeof mock.total_count === "number");
  });

  it("messages have required fields", () => {
    const msg = mock.messages[0];
    for (const key of ["message_id", "subject", "sender_email", "recipient_email", "received_time", "judgement"]) {
      assert.ok(msg[key] !== undefined, `Missing ${key}`);
    }
  });
});

describe("Mock remediation response structure", () => {
  const mock = {
    activity_log_id: "act-d4e5f6a7-b8c9-0123-def4-567890abcdef",
    status: "pending",
  };

  it("has activity_log_id string", () => {
    assert.ok(typeof mock.activity_log_id === "string");
    assert.ok(mock.activity_log_id.length > 0);
  });

  it("has status field", () => {
    assert.ok(typeof mock.status === "string");
  });
});

describe("Mock status response structure", () => {
  const mock = {
    activity_log_id: "act-d4e5f6a7-b8c9-0123-def4-567890abcdef",
    status: "completed",
    action: "delete",
    message_count: 3,
    completed_at: "2026-03-24T15:45:00Z",
  };

  it("has valid status value", () => {
    const validStatuses = ["pending", "in_progress", "completed", "failed"];
    assert.ok(validStatuses.includes(mock.status), `Unexpected status: ${mock.status}`);
  });

  it("has message_count as number", () => {
    assert.ok(typeof mock.message_count === "number");
  });

  it("has activity_log_id", () => {
    assert.ok(typeof mock.activity_log_id === "string");
  });
});
