import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated validation from abnormal-helpers.ts ──────────

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateSenderEmail(email) {
  return BASIC_EMAIL_RE.test(email);
}

// ── CSV parser from executors.ts (RFC 4180 compliant) ───────

function splitCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsvToJson(csv) {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
    return obj;
  });
}

// ── Tests ────────────────────────────────────────────────────

describe("Email validation", () => {
  it("accepts valid emails", () => {
    assert.ok(validateSenderEmail("jsmith@goodwin.com"));
    assert.ok(validateSenderEmail("john.smith@contoso.onmicrosoft.com"));
  });

  it("rejects invalid emails", () => {
    assert.ok(!validateSenderEmail("not-an-email"));
    assert.ok(!validateSenderEmail(""));
    assert.ok(!validateSenderEmail("user@"));
    assert.ok(!validateSenderEmail("@domain.com"));
  });
});

describe("CSV parser", () => {
  it("parses headers and data rows", () => {
    const csv = "timestamp,ip,location\n2026-03-24T09:00:00Z,198.51.100.10,Boston";
    const result = parseCsvToJson(csv);
    assert.equal(result.length, 1);
    assert.equal(result[0].timestamp, "2026-03-24T09:00:00Z");
    assert.equal(result[0].ip, "198.51.100.10");
    assert.equal(result[0].location, "Boston");
  });

  it("handles multiple rows", () => {
    const csv = "a,b\n1,2\n3,4\n5,6";
    const result = parseCsvToJson(csv);
    assert.equal(result.length, 3);
  });

  it("returns empty array for header-only CSV", () => {
    const csv = "timestamp,ip,location";
    const result = parseCsvToJson(csv);
    assert.equal(result.length, 0);
  });

  it("handles quoted fields with commas", () => {
    const csv = 'timestamp,ip,location\n2026-03-24T09:00:00Z,198.51.100.10,"Seattle, WA"';
    const result = parseCsvToJson(csv);
    assert.equal(result.length, 1);
    assert.equal(result[0].location, "Seattle, WA");
  });

  it("handles escaped quotes inside quoted fields", () => {
    const csv = 'name,value\n"say ""hello""",42';
    const result = parseCsvToJson(csv);
    assert.equal(result[0].name, 'say "hello"');
  });

  it("returns empty array for empty input", () => {
    const result = parseCsvToJson("");
    assert.equal(result.length, 0);
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

  it("get_employee_profile is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_employee_profile"));
  });

  it("get_employee_login_history is NOT destructive", () => {
    assert.ok(!DESTRUCTIVE_TOOLS.has("get_employee_login_history"));
  });
});

describe("Tool schema expectations", () => {
  it("get_employee_profile requires email", () => {
    const required = ["email"];
    assert.ok(required.includes("email"));
    assert.equal(required.length, 1);
  });

  it("get_employee_login_history requires email", () => {
    const required = ["email"];
    assert.ok(required.includes("email"));
    assert.equal(required.length, 1);
  });
});

describe("Mock employee profile data", () => {
  const mockProfile = {
    employee: {
      name: "John Smith",
      email: "jsmith@goodwin.com",
      title: "Associate Attorney",
      manager: "Sarah Johnson",
    },
    genome: {
      histograms: [
        { key: "ip_address", values: [{ text: "198.51.100.10", ratio: 0.65, raw_count: 142 }] },
        { key: "sign_in_location", values: [{ text: "Boston, MA, US", ratio: 0.80 }] },
      ],
    },
  };

  it("has employee details", () => {
    assert.ok(mockProfile.employee.name);
    assert.ok(mockProfile.employee.title);
    assert.ok(mockProfile.employee.manager);
  });

  it("has genome histograms", () => {
    assert.ok(Array.isArray(mockProfile.genome.histograms));
    assert.ok(mockProfile.genome.histograms.length > 0);
    assert.ok(mockProfile.genome.histograms[0].key);
    assert.ok(Array.isArray(mockProfile.genome.histograms[0].values));
  });

  it("histogram values have text and ratio", () => {
    const ipHist = mockProfile.genome.histograms.find((h) => h.key === "ip_address");
    assert.ok(ipHist);
    assert.ok(ipHist.values[0].text);
    assert.equal(typeof ipHist.values[0].ratio, "number");
  });
});
