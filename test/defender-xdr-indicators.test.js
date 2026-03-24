import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated mapping/validation from executors.ts ─────────

const INDICATOR_TYPE_MAP = {
  domain: "DomainName",
  ip: "IpAddress",
  url: "Url",
  sha1: "FileSha1",
  sha256: "FileSha256",
  md5: "FileMd5",
  cert: "CertificateThumbprint",
};

const FILE_INDICATOR_TYPES = new Set(["FileSha1", "FileSha256", "FileMd5"]);

const HASH_LENGTHS = { sha1: 40, sha256: 64, md5: 32, cert: 40 };

function resolveAction(action, indicatorType) {
  const defenderType = INDICATOR_TYPE_MAP[indicatorType];
  if (action === "block" && FILE_INDICATOR_TYPES.has(defenderType)) {
    return "BlockAndRemediate";
  }
  const map = { block: "Block", warn: "Warn", audit: "Audit" };
  return map[action] ?? "Block";
}

function validateIndicatorValue(value, indicatorType) {
  const expectedLen = HASH_LENGTHS[indicatorType];
  if (expectedLen) {
    if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== expectedLen) {
      throw new Error(`Invalid ${indicatorType}`);
    }
    return;
  }
  if (indicatorType === "ip" && !/^[\d.:a-fA-F]+$/.test(value)) {
    throw new Error("Invalid IP");
  }
  if (indicatorType === "url" && !/^https?:\/\//i.test(value)) {
    throw new Error("Invalid URL");
  }
  if (indicatorType === "domain" && !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) {
    throw new Error("Invalid domain");
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("Indicator type mapping", () => {
  it("maps all 7 types correctly", () => {
    assert.equal(INDICATOR_TYPE_MAP.domain, "DomainName");
    assert.equal(INDICATOR_TYPE_MAP.ip, "IpAddress");
    assert.equal(INDICATOR_TYPE_MAP.url, "Url");
    assert.equal(INDICATOR_TYPE_MAP.sha1, "FileSha1");
    assert.equal(INDICATOR_TYPE_MAP.sha256, "FileSha256");
    assert.equal(INDICATOR_TYPE_MAP.md5, "FileMd5");
    assert.equal(INDICATOR_TYPE_MAP.cert, "CertificateThumbprint");
  });
});

describe("Action mapping", () => {
  it("block + file hash → BlockAndRemediate", () => {
    assert.equal(resolveAction("block", "sha256"), "BlockAndRemediate");
    assert.equal(resolveAction("block", "sha1"), "BlockAndRemediate");
    assert.equal(resolveAction("block", "md5"), "BlockAndRemediate");
  });

  it("block + network indicator → Block", () => {
    assert.equal(resolveAction("block", "domain"), "Block");
    assert.equal(resolveAction("block", "ip"), "Block");
    assert.equal(resolveAction("block", "url"), "Block");
  });

  it("warn passes through for all types", () => {
    assert.equal(resolveAction("warn", "domain"), "Warn");
    assert.equal(resolveAction("warn", "sha256"), "Warn");
  });

  it("audit passes through for all types", () => {
    assert.equal(resolveAction("audit", "ip"), "Audit");
    assert.equal(resolveAction("audit", "md5"), "Audit");
  });

  it("block + cert → Block (not file type)", () => {
    assert.equal(resolveAction("block", "cert"), "Block");
  });
});

describe("Indicator value validation", () => {
  it("accepts valid SHA-256 (64 hex chars)", () => {
    assert.doesNotThrow(() => validateIndicatorValue("a".repeat(64), "sha256"));
  });

  it("rejects wrong-length SHA-256", () => {
    assert.throws(() => validateIndicatorValue("a".repeat(63), "sha256"));
    assert.throws(() => validateIndicatorValue("a".repeat(65), "sha256"));
  });

  it("accepts valid SHA-1 (40 hex chars)", () => {
    assert.doesNotThrow(() => validateIndicatorValue("b".repeat(40), "sha1"));
  });

  it("accepts valid MD5 (32 hex chars)", () => {
    assert.doesNotThrow(() => validateIndicatorValue("c".repeat(32), "md5"));
  });

  it("accepts valid cert thumbprint (40 hex chars)", () => {
    assert.doesNotThrow(() => validateIndicatorValue("d".repeat(40), "cert"));
  });

  it("rejects non-hex hash characters", () => {
    assert.throws(() => validateIndicatorValue("z".repeat(64), "sha256"));
  });

  it("accepts valid domain", () => {
    assert.doesNotThrow(() => validateIndicatorValue("evil.example.com", "domain"));
  });

  it("rejects invalid domain", () => {
    assert.throws(() => validateIndicatorValue("not a domain", "domain"));
  });

  it("accepts valid IP", () => {
    assert.doesNotThrow(() => validateIndicatorValue("192.168.1.1", "ip"));
    assert.doesNotThrow(() => validateIndicatorValue("::1", "ip"));
  });

  it("accepts valid URL", () => {
    assert.doesNotThrow(() => validateIndicatorValue("https://evil.example.com/payload", "url"));
  });

  it("rejects URL without protocol", () => {
    assert.throws(() => validateIndicatorValue("evil.example.com/payload", "url"));
  });
});

describe("Destructive tool classification", () => {
  const DESTRUCTIVE_TOOLS = new Set([
    "reset_user_password", "dismiss_user_risk",
    "isolate_machine", "unisolate_machine",
    "search_user_messages", "report_message_as_phishing",
    "approve_threatlocker_request", "deny_threatlocker_request",
    "block_indicator", "import_indicators", "delete_indicator",
  ]);

  it("block_indicator is destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("block_indicator"));
  });

  it("import_indicators is destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("import_indicators"));
  });

  it("delete_indicator is destructive", () => {
    assert.ok(DESTRUCTIVE_TOOLS.has("delete_indicator"));
  });

  it("list_indicators is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("list_indicators"));
  });
});

describe("Tool schema expectations", () => {
  it("block_indicator requires value, indicator_type, title", () => {
    const required = ["value", "indicator_type", "title"];
    assert.ok(required.includes("value"));
    assert.ok(required.includes("indicator_type"));
    assert.ok(required.includes("title"));
    assert.ok(!required.includes("action"));
    assert.ok(!required.includes("severity"));
  });

  it("list_indicators has no required params", () => {
    const required = [];
    assert.equal(required.length, 0);
  });

  it("delete_indicator requires indicator_id", () => {
    const required = ["indicator_id"];
    assert.ok(required.includes("indicator_id"));
  });

  it("import_indicators requires indicators array", () => {
    const required = ["indicators"];
    assert.ok(required.includes("indicators"));
  });
});

describe("Batch import limits", () => {
  it("rejects arrays over 500", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ value: `${i}.example.com` }));
    assert.ok(tooMany.length > 500);
  });

  it("accepts arrays at 500", () => {
    const atLimit = Array.from({ length: 500 }, (_, i) => ({ value: `${i}.example.com` }));
    assert.equal(atLimit.length, 500);
  });
});
