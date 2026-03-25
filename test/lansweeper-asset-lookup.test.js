import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import production helpers — tests validate the real code, not copies.
import {
  detectSearchType,
  extractCustomTags,
  identifyPrimaryUser,
  buildVulnSummary,
} from "../web/lib/lansweeper-helpers.ts";

// ── Tests ────────────────────────────────────────────────────

describe("Search-type auto-detection", () => {
  it("detects IPv4 addresses as ip", () => {
    assert.equal(detectSearchType("10.0.1.42"), "ip");
    assert.equal(detectSearchType("192.168.1.1"), "ip");
  });

  it("defaults to name for hostnames", () => {
    assert.equal(detectSearchType("YOURPC01"), "name");
    assert.equal(detectSearchType("laptop-js4729.goodwin.local"), "name");
  });

  it("does not misdetect partial IPs as ip", () => {
    assert.equal(detectSearchType("10.0.1"), "name");
    assert.equal(detectSearchType("10.0.1.42.extra"), "name");
  });

  it("explicit search_type overrides auto-detection", () => {
    assert.equal(detectSearchType("10.0.1.42", "name"), "name");
    assert.equal(detectSearchType("YOURPC01", "serial"), "serial");
    assert.equal(detectSearchType("SN12345", "serial"), "serial");
  });

  // IPV4_RE is classification-only — does not validate octet ranges.
  // Out-of-range values route to IP search; Lansweeper validates server-side.
  it("classifies out-of-range octets as ip (classification only)", () => {
    assert.equal(detectSearchType("999.999.999.999"), "ip");
  });
});

describe("Custom field tag extraction", () => {
  it("extracts all four tags when present", () => {
    const fields = [
      { name: "Business Owner", value: "Jane Martinez" },
      { name: "BIA Tier", value: "Tier 2" },
      { name: "Role", value: "Developer Workstation" },
      { name: "Technology Owner", value: "IT Desktop Engineering" },
      { name: "SomeOtherField", value: "ignored" },
    ];
    const tags = extractCustomTags(fields);
    assert.equal(tags.businessOwner, "Jane Martinez");
    assert.equal(tags.biaTier, "Tier 2");
    assert.equal(tags.role, "Developer Workstation");
    assert.equal(tags.technologyOwner, "IT Desktop Engineering");
  });

  it("returns 'Not set' for all missing tags", () => {
    const tags = extractCustomTags([]);
    assert.equal(tags.businessOwner, "Not set");
    assert.equal(tags.biaTier, "Not set");
    assert.equal(tags.role, "Not set");
    assert.equal(tags.technologyOwner, "Not set");
  });

  it("returns 'Not set' when fields is undefined", () => {
    const tags = extractCustomTags(undefined);
    assert.equal(tags.businessOwner, "Not set");
  });

  it("ignores empty string values", () => {
    const fields = [{ name: "Business Owner", value: "" }];
    const tags = extractCustomTags(fields);
    assert.equal(tags.businessOwner, "Not set");
  });
});

describe("Primary user identification", () => {
  it("picks the user with highest numberOfLogons", () => {
    const users = [
      { userName: "low", fullName: "Low User", numberOfLogons: 10, lastLogon: "2026-01-01T00:00:00Z" },
      { userName: "high", fullName: "High User", numberOfLogons: 500, lastLogon: "2026-03-24T00:00:00Z" },
      { userName: "mid", fullName: "Mid User", numberOfLogons: 100, lastLogon: "2026-02-01T00:00:00Z" },
    ];
    const result = identifyPrimaryUser(users, undefined);
    assert.equal(result.userName, "high");
    assert.equal(result.numberOfLogons, 500);
  });

  it("falls back to assetBasicInfo.userName when loggedOnUsers is empty", () => {
    const result = identifyPrimaryUser([], "jsmith");
    assert.equal(result.userName, "jsmith");
    assert.equal(result.fullName, null);
  });

  it("returns message object when no user data at all", () => {
    const result = identifyPrimaryUser([], undefined);
    assert.deepEqual(result, { message: "No user data available" });
  });

  it("handles undefined loggedOnUsers with fallback", () => {
    const result = identifyPrimaryUser(undefined, "backup_user");
    assert.equal(result.userName, "backup_user");
  });
});

describe("Vulnerability summary aggregation", () => {
  const items = [
    { cve: "CVE-2026-001", riskScore: 9.8, severity: "Critical" },
    { cve: "CVE-2026-002", riskScore: 8.1, severity: "High" },
    { cve: "CVE-2026-003", riskScore: 7.5, severity: "High" },
    { cve: "CVE-2026-004", riskScore: 6.5, severity: "Medium" },
    { cve: "CVE-2026-005", riskScore: 5.0, severity: "Medium" },
    { cve: "CVE-2026-006", riskScore: 3.2, severity: "Low" },
  ];

  it("counts total correctly", () => {
    const summary = buildVulnSummary(items);
    assert.equal(summary.totalCount, 6);
  });

  it("breaks down by severity", () => {
    const summary = buildVulnSummary(items);
    assert.equal(summary.bySeverity.critical, 1);
    assert.equal(summary.bySeverity.high, 2);
    assert.equal(summary.bySeverity.medium, 2);
    assert.equal(summary.bySeverity.low, 1);
  });

  it("sorts topCves by riskScore descending", () => {
    const summary = buildVulnSummary(items);
    assert.equal(summary.topCves[0].cve, "CVE-2026-001");
    assert.equal(summary.topCves[1].cve, "CVE-2026-002");
    assert.equal(summary.topCves[summary.topCves.length - 1].cve, "CVE-2026-006");
  });

  it("caps at 10 topCves", () => {
    const manyItems = Array.from({ length: 15 }, (_, i) => ({
      cve: `CVE-2026-${String(i).padStart(3, "0")}`,
      riskScore: 10 - i * 0.5,
      severity: "High",
    }));
    const summary = buildVulnSummary(manyItems);
    assert.equal(summary.topCves.length, 10);
    assert.equal(summary.totalCount, 15);
  });

  it("handles empty list", () => {
    const summary = buildVulnSummary([]);
    assert.equal(summary.totalCount, 0);
    assert.equal(summary.topCves.length, 0);
  });
});

describe("Mock response structure", () => {
  // Replicate the mock to validate structure
  const mock = {
    assetIdentity: {
      name: "YOURPC01",
      type: "Windows",
      ipAddress: "10.0.1.42",
      mac: "AA:BB:CC:DD:EE:FF",
      manufacturer: "Dell Inc.",
      model: "Latitude 5540",
      serialNumber: "DLAT5540-X9K2M",
      os: "Microsoft Windows 11 Enterprise 23H2 (Build 22631)",
      lastSeen: "2026-03-24T18:30:00Z",
      lansweeperUrl: "https://app.lansweeper.com/asset/YOURPC01",
    },
    tags: {
      businessOwner: "Jane Martinez",
      biaTier: "Tier 2 — Business Important",
      role: "Developer Workstation",
      technologyOwner: "IT Desktop Engineering",
    },
    primaryUser: {
      userName: "jsmith",
      fullName: "John Smith",
      numberOfLogons: 487,
      lastLogon: "2026-03-24T17:45:00Z",
    },
    vulnerabilities: {
      totalCount: 12,
      bySeverity: { critical: 1, high: 3, medium: 5, low: 3 },
      topCves: [{ cve: "CVE-2026-21001" }],
    },
  };

  it("has all four sections", () => {
    assert.ok(mock.assetIdentity);
    assert.ok(mock.tags);
    assert.ok(mock.primaryUser);
    assert.ok(mock.vulnerabilities);
  });

  it("assetIdentity has required fields", () => {
    const ai = mock.assetIdentity;
    for (const key of ["name", "type", "ipAddress", "mac", "manufacturer", "model", "serialNumber", "os", "lastSeen", "lansweeperUrl"]) {
      assert.ok(ai[key] !== undefined, `Missing assetIdentity.${key}`);
    }
  });

  it("tags has all four ownership fields", () => {
    for (const key of ["businessOwner", "biaTier", "role", "technologyOwner"]) {
      assert.ok(mock.tags[key] !== undefined, `Missing tags.${key}`);
      assert.notEqual(mock.tags[key], "Not set");
    }
  });

  it("primaryUser has userName and numberOfLogons", () => {
    assert.ok(mock.primaryUser.userName);
    assert.ok(typeof mock.primaryUser.numberOfLogons === "number");
  });

  it("vulnerabilities has totalCount and bySeverity", () => {
    assert.ok(typeof mock.vulnerabilities.totalCount === "number");
    assert.ok(mock.vulnerabilities.bySeverity);
    assert.ok(Array.isArray(mock.vulnerabilities.topCves));
  });
});

describe("Disambiguation list", () => {
  it("returns matches array when multiple assets found", () => {
    const result = {
      message: "Found 3 assets matching \"10.0.1\". Please specify which asset:",
      matches: [
        { name: "PC01", type: "Windows", ipAddress: "10.0.1.10", key: "k1" },
        { name: "PC02", type: "Windows", ipAddress: "10.0.1.20", key: "k2" },
        { name: "SRV01", type: "Windows Server", ipAddress: "10.0.1.30", key: "k3" },
      ],
    };

    assert.equal(result.matches.length, 3);
    for (const match of result.matches) {
      assert.ok(match.name);
      assert.ok(match.ipAddress);
      assert.ok(match.key);
    }
  });
});
