// ─────────────────────────────────────────────────────────────
//  MCP tool-name matcher with simple glob support.
//
//  Used by the per-role MCP allow-list machinery in
//  `mcp-servers.ts` to decide whether a given Wiz (or future
//  vendor) tool name is permitted for a given caller. Kept in its
//  own module so the matcher is unit-testable in isolation and
//  reusable when we wire additional MCP servers behind the same
//  RBAC pattern.
//
//  Semantics
//    matchesAllowedTools(name, undefined) → true (allow-all)
//    matchesAllowedTools(name, [])        → false (deny-all)
//    matchesAllowedTools(name, ["x"])     → name === "x"
//    matchesAllowedTools(name, ["x*"])    → name starts with "x"
//    matchesAllowedTools(name, ["*x"])    → name ends with "x"
//    matchesAllowedTools(name, ["*x*"])   → name contains "x"
//
//  Globbing is shell-style `*` only — no `?`, no character
//  classes, no recursive `**`. The spec's open-question answer
//  was "glob support" with no further nuance; this is the
//  minimum that closes the "wiz_get_*" use case without
//  pulling in a dependency.
// ─────────────────────────────────────────────────────────────

/**
 * Decide whether `toolName` is permitted by `allowedTools`.
 *
 * - `undefined` allow-list ⇒ all tools allowed (server-side default)
 * - Empty array ⇒ no tools allowed (explicit deny-all)
 * - Otherwise ⇒ true iff any pattern in the array matches.
 *
 * Patterns may contain literal `*` wildcards. Everything else is
 * treated as a literal character (regex metacharacters in the
 * pattern are escaped before compilation).
 */
export function matchesAllowedTools(
  toolName: string,
  allowedTools: string[] | undefined,
): boolean {
  if (allowedTools === undefined) return true;
  if (allowedTools.length === 0) return false;
  return allowedTools.some((pattern) => patternMatches(toolName, pattern));
}

/**
 * Expand an array of patterns against a catalogue of known tool
 * names, returning the literal subset that any pattern covers.
 * Used at request-construction time to build the literal
 * `tool_configuration.allowed_tools` array Anthropic's MCP
 * connector requires — it does not accept globs.
 *
 * The catalogue is the source of truth for "what Wiz tools
 * exist". When Wiz adds a new tool, operators extend the
 * catalogue constant in `mcp-servers.ts`. Until then, a glob
 * like `wiz_get_*` covers only the tools known at deploy time.
 */
export function expandPatternsAgainstCatalogue(
  patterns: string[] | undefined,
  catalogue: readonly string[],
): string[] | undefined {
  if (patterns === undefined) return undefined;
  const matched = new Set<string>();
  for (const tool of catalogue) {
    if (matchesAllowedTools(tool, patterns)) {
      matched.add(tool);
    }
  }
  return Array.from(matched).sort();
}

// Internal — turn a single pattern with `*` wildcards into a
// RegExp matching the whole string. Non-`*` characters are
// escaped so a pattern containing `.` (e.g. `wiz_get_issues.v2`)
// matches only the literal dot, not "any character".
function patternMatches(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern;
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(value);
}
