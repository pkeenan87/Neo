import { describe, expect, it } from "vitest";

import {
  matchesAllowedTools,
  expandPatternsAgainstCatalogue,
} from "../lib/mcp-tool-matcher";

describe("matchesAllowedTools", () => {
  it("returns true for undefined allow-list (allow-all)", () => {
    expect(matchesAllowedTools("wiz_anything", undefined)).toBe(true);
  });

  it("returns false for empty allow-list (deny-all)", () => {
    expect(matchesAllowedTools("wiz_anything", [])).toBe(false);
  });

  it("returns true on exact literal match", () => {
    expect(matchesAllowedTools("wiz_get_issues", ["wiz_get_issues"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchesAllowedTools("wiz_get_issues", ["wiz_get_compliance"])).toBe(false);
  });

  it("supports prefix wildcards (wiz_get_*)", () => {
    expect(matchesAllowedTools("wiz_get_issues", ["wiz_get_*"])).toBe(true);
    expect(matchesAllowedTools("wiz_get_vulnerabilities", ["wiz_get_*"])).toBe(true);
    expect(matchesAllowedTools("wiz_list_anything", ["wiz_get_*"])).toBe(false);
  });

  it("supports suffix wildcards (*_issues)", () => {
    expect(matchesAllowedTools("wiz_get_issues", ["*_issues"])).toBe(true);
    expect(matchesAllowedTools("wiz_get_compliance", ["*_issues"])).toBe(false);
  });

  it("supports contains wildcards (*get*)", () => {
    expect(matchesAllowedTools("wiz_get_issues", ["*get*"])).toBe(true);
    expect(matchesAllowedTools("wiz_list_anything", ["*get*"])).toBe(false);
  });

  it("returns true when any one of multiple patterns matches", () => {
    expect(
      matchesAllowedTools("wiz_get_compliance", ["wiz_search_*", "wiz_get_*"]),
    ).toBe(true);
  });

  it("escapes regex metacharacters in the literal portion of a pattern", () => {
    // A dot in the pattern must match only a literal dot, not "any char"
    expect(matchesAllowedTools("wiz_get_issues", ["wiz.get.issues"])).toBe(false);
    expect(matchesAllowedTools("wiz.get.issues", ["wiz.get.issues"])).toBe(true);
  });

  it("does not support `?` wildcards (only `*`)", () => {
    // `?` should be treated as a literal `?` character
    expect(matchesAllowedTools("wiz_get_issuesx", ["wiz_get_issues?"])).toBe(false);
    expect(matchesAllowedTools("wiz_get_issues?", ["wiz_get_issues?"])).toBe(true);
  });
});

describe("expandPatternsAgainstCatalogue", () => {
  const catalogue = [
    "wiz_get_issues",
    "wiz_get_vulnerabilities",
    "wiz_get_compliance",
    "wiz_list_cloud_resources",
    "wiz_search_security_graph",
    "wiz_get_defend_threat",
  ] as const;

  it("returns undefined for undefined patterns (allow-all stays allow-all)", () => {
    expect(expandPatternsAgainstCatalogue(undefined, catalogue)).toBeUndefined();
  });

  it("returns an empty array for empty patterns (explicit deny)", () => {
    expect(expandPatternsAgainstCatalogue([], catalogue)).toEqual([]);
  });

  it("expands a glob against the catalogue", () => {
    const expanded = expandPatternsAgainstCatalogue(["wiz_get_*"], catalogue);
    expect(expanded).toEqual([
      "wiz_get_compliance",
      "wiz_get_defend_threat",
      "wiz_get_issues",
      "wiz_get_vulnerabilities",
    ]);
  });

  it("deduplicates when multiple patterns cover the same tool", () => {
    const expanded = expandPatternsAgainstCatalogue(
      ["wiz_get_*", "*issues"],
      catalogue,
    );
    // wiz_get_issues is covered by both — should appear once
    expect(expanded?.filter((t) => t === "wiz_get_issues")).toHaveLength(1);
  });

  it("returns sorted output for stable, diff-friendly serialization", () => {
    const expanded = expandPatternsAgainstCatalogue(
      ["wiz_search_*", "wiz_list_*"],
      catalogue,
    );
    expect(expanded).toEqual([
      "wiz_list_cloud_resources",
      "wiz_search_security_graph",
    ]);
  });

  it("ignores patterns that don't match any catalogue entry (no fabrication)", () => {
    expect(
      expandPatternsAgainstCatalogue(["wiz_not_in_catalogue"], catalogue),
    ).toEqual([]);
  });
});
