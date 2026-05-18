import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated logic from executors.ts ───────────────────────
// These mirror the small classifier / normalizer / mock helpers
// in web/lib/executors.ts. Replicating in-process avoids pulling
// the full TypeScript executor surface into the test runner.

const DEFENDER_HUNTING_ROW_CAP = 100_000;

function classifyHuntingQuotaKind(body) {
  return /cpu|concurrent/i.test(body) ? "cpu" : "rate";
}

function lookupRowValue(row, columnName) {
  if (columnName in row) return row[columnName];
  const camel = columnName.charAt(0).toLowerCase() + columnName.slice(1);
  return row[camel];
}

function normalizeHuntingResponse(payload) {
  const obj = payload ?? {};
  const columns = (obj.schema ?? []).map((c) => ({ name: c.name, type: c.type }));
  const results = obj.results ?? [];
  const rows = results.map((r) => columns.map((c) => lookupRowValue(r, c.name)));
  return {
    tables: [{ name: "PrimaryResult", columns, rows }],
    rowCount: rows.length,
    truncationPossible: rows.length >= DEFENDER_HUNTING_ROW_CAP,
  };
}

function mockDefenderHuntingQuery(query) {
  const q = query.toLowerCase();

  if (q.includes("simulate_truncation")) {
    return {
      tables: [{ name: "PrimaryResult", columns: [{ name: "DeviceId", type: "string" }], rows: [["truncation-marker"]] }],
      rowCount: 1,
      truncationPossible: true,
      _mock: true,
    };
  }

  if (q.includes("devicetvmsecureconfigurationassessment")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: [
          { name: "DeviceId", type: "string" },
          { name: "IsCompliant", type: "long" },
          { name: "ConfigurationId", type: "string" },
        ],
        rows: [["dev-001", 0, "scid-2000"]],
      }],
      rowCount: 1,
      truncationPossible: false,
      _mock: true,
    };
  }

  if (q.includes("devicetvmsoftwarevulnerabilities")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: [
          { name: "DeviceId", type: "string" },
          { name: "CveId", type: "string" },
          { name: "VulnerabilitySeverityLevel", type: "string" },
        ],
        rows: [["dev-001", "CVE-2026-1234", "Critical"]],
      }],
      rowCount: 1,
      truncationPossible: false,
      _mock: true,
    };
  }

  if (q.includes("devicetvmsoftwareinventory")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: [
          { name: "DeviceId", type: "string" },
          { name: "SoftwareName", type: "string" },
          { name: "EndOfSupportStatus", type: "string" },
        ],
        rows: [["dev-001", "chrome", "None"]],
      }],
      rowCount: 1,
      truncationPossible: false,
      _mock: true,
    };
  }

  if (q.includes("devicetvminfogathering")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: [
          { name: "DeviceId", type: "string" },
          { name: "FieldName", type: "string" },
          { name: "FieldValue", type: "string" },
        ],
        rows: [["dev-001", "SmbV1Enabled", "false"]],
      }],
      rowCount: 1,
      truncationPossible: false,
      _mock: true,
    };
  }

  return {
    tables: [{ name: "PrimaryResult", columns: [], rows: [] }],
    rowCount: 0,
    truncationPossible: false,
    _mock: true,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("classifyHuntingQuotaKind", () => {
  it("classifies plain rate-quota bodies as 'rate'", () => {
    assert.equal(classifyHuntingQuotaKind("Api calls quota exceeded for this tenant"), "rate");
    assert.equal(classifyHuntingQuotaKind("Too many requests"), "rate");
  });

  it("classifies CPU-quota bodies as 'cpu'", () => {
    assert.equal(classifyHuntingQuotaKind("CPU quota exceeded for this tenant"), "cpu");
    assert.equal(classifyHuntingQuotaKind("Concurrent requests quota exceeded"), "cpu");
    assert.equal(classifyHuntingQuotaKind("cpu time exhausted"), "cpu");
  });

  it("defaults to 'rate' when the body is empty or unrecognised", () => {
    assert.equal(classifyHuntingQuotaKind(""), "rate");
    assert.equal(classifyHuntingQuotaKind("Service unavailable"), "rate");
  });
});

describe("normalizeHuntingResponse", () => {
  // The Graph API returns lowercase top-level keys. Verified against
  // https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery
  it("maps the documented Graph shape (lowercase schema/results) into the tabular form", () => {
    const payload = {
      schema: [
        { name: "Timestamp", type: "DateTime" },
        { name: "FileName", type: "String" },
        { name: "InitiatingProcessFileName", type: "String" },
      ],
      results: [
        { Timestamp: "2024-03-26T09:39:50Z", FileName: "cmd.exe", InitiatingProcessFileName: "powershell.exe" },
        { Timestamp: "2024-03-26T09:39:49Z", FileName: "cmd.exe", InitiatingProcessFileName: "powershell.exe" },
      ],
    };
    const out = normalizeHuntingResponse(payload);
    assert.equal(out.tables.length, 1);
    assert.equal(out.tables[0].name, "PrimaryResult");
    assert.deepEqual(out.tables[0].columns, [
      { name: "Timestamp", type: "DateTime" },
      { name: "FileName", type: "String" },
      { name: "InitiatingProcessFileName", type: "String" },
    ]);
    assert.deepEqual(out.tables[0].rows, [
      ["2024-03-26T09:39:50Z", "cmd.exe", "powershell.exe"],
      ["2024-03-26T09:39:49Z", "cmd.exe", "powershell.exe"],
    ]);
    assert.equal(out.rowCount, 2);
    assert.equal(out.truncationPossible, false);
  });

  it("falls back to lowercase-first-letter when row keys are camelCased (Example 2 in Graph docs)", () => {
    const payload = {
      schema: [
        { name: "Timestamp", type: "DateTime" },
        { name: "FileName", type: "String" },
      ],
      results: [
        { timestamp: "2020-08-30T06:38:35Z", fileName: "conhost.exe" },
      ],
    };
    const out = normalizeHuntingResponse(payload);
    assert.deepEqual(out.tables[0].rows, [["2020-08-30T06:38:35Z", "conhost.exe"]]);
  });

  it("handles an empty results array", () => {
    const out = normalizeHuntingResponse({ schema: [{ name: "DeviceId", type: "string" }], results: [] });
    assert.deepEqual(out.tables[0].rows, []);
    assert.equal(out.rowCount, 0);
    assert.equal(out.truncationPossible, false);
  });

  it("handles missing schema and results gracefully", () => {
    const out = normalizeHuntingResponse({});
    assert.deepEqual(out.tables[0].columns, []);
    assert.deepEqual(out.tables[0].rows, []);
    assert.equal(out.rowCount, 0);
  });

  it("flags truncationPossible when row count hits the API cap", () => {
    const results = Array.from({ length: DEFENDER_HUNTING_ROW_CAP }, (_, i) => ({ DeviceId: `d-${i}` }));
    const out = normalizeHuntingResponse({ schema: [{ name: "DeviceId", type: "string" }], results });
    assert.equal(out.truncationPossible, true);
    assert.equal(out.rowCount, DEFENDER_HUNTING_ROW_CAP);
  });

  it("does not flag truncationPossible below the cap", () => {
    const results = Array.from({ length: 50 }, (_, i) => ({ DeviceId: `d-${i}` }));
    const out = normalizeHuntingResponse({ schema: [{ name: "DeviceId", type: "string" }], results });
    assert.equal(out.truncationPossible, false);
  });

  it("rejects the legacy PascalCase shape — Graph v1.0 does not return it", () => {
    // Regression guard. Earlier code assumed Schema/Results (PascalCase) which
    // matched the legacy MDE advancedhunting/run endpoint but NOT Graph's
    // /v1.0/security/runHuntingQuery, where keys are lowercase. A PascalCase
    // payload here must produce an empty result rather than silently appear
    // to "work" against a wrong-shaped fixture.
    const payload = {
      Schema: [{ Name: "DeviceId", Type: "string" }],
      Results: [{ DeviceId: "abc" }],
    };
    const out = normalizeHuntingResponse(payload);
    assert.deepEqual(out.tables[0].columns, []);
    assert.deepEqual(out.tables[0].rows, []);
  });
});

describe("mockDefenderHuntingQuery routing", () => {
  it("returns compliance rows for DeviceTvmSecureConfigurationAssessment queries", () => {
    const out = mockDefenderHuntingQuery("DeviceTvmSecureConfigurationAssessment | where IsCompliant == 0");
    const cols = out.tables[0].columns.map((c) => c.name);
    assert.ok(cols.includes("IsCompliant"));
    assert.ok(cols.includes("ConfigurationId"));
    assert.ok(out.tables[0].rows.length > 0);
    assert.equal(out._mock, true);
  });

  it("returns CVE rows for DeviceTvmSoftwareVulnerabilities queries", () => {
    const out = mockDefenderHuntingQuery("DeviceTvmSoftwareVulnerabilities | take 100");
    const cols = out.tables[0].columns.map((c) => c.name);
    assert.ok(cols.includes("CveId"));
    assert.ok(cols.includes("VulnerabilitySeverityLevel"));
  });

  it("returns inventory rows for DeviceTvmSoftwareInventory queries", () => {
    const out = mockDefenderHuntingQuery("DeviceTvmSoftwareInventory | summarize count() by SoftwareName");
    const cols = out.tables[0].columns.map((c) => c.name);
    assert.ok(cols.includes("SoftwareName"));
    assert.ok(cols.includes("EndOfSupportStatus"));
  });

  it("returns gathering rows for DeviceTvmInfoGathering queries", () => {
    const out = mockDefenderHuntingQuery("DeviceTvmInfoGathering | where FieldName == 'SmbV1Enabled'");
    const cols = out.tables[0].columns.map((c) => c.name);
    assert.ok(cols.includes("FieldName"));
    assert.ok(cols.includes("FieldValue"));
  });

  it("flags truncationPossible when the simulate_truncation marker is present", () => {
    const out = mockDefenderHuntingQuery("DeviceTvmSoftwareInventory | where Note == 'simulate_truncation'");
    assert.equal(out.truncationPossible, true);
  });

  it("returns the empty fallback for unrecognised tables", () => {
    const out = mockDefenderHuntingQuery("SomeOtherTable | take 1");
    assert.deepEqual(out.tables[0].rows, []);
    assert.deepEqual(out.tables[0].columns, []);
    assert.equal(out.rowCount, 0);
    assert.equal(out.truncationPossible, false);
    assert.equal(out._mock, true);
  });
});
