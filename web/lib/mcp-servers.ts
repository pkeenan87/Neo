// ─────────────────────────────────────────────────────────────
//  MCP server registry — per-role configuration.
//
//  Wiz is the first concrete entry; the shape is built so future
//  integrations (Abnormal, Lansweeper, AppOmni, ThreatLocker)
//  plug in without further changes to `agent.ts` or the prompt
//  layer. See _specs/wiz-mcp-server-integration.md.
//
//  Architecture
//
//    getMcpServers(role)
//      ↓
//    [registry] → role filter → token fetch → glob expansion
//      ↓
//    Array<McpServerConfig> ready to spread into the Anthropic
//    beta.messages.create call's mcp_servers param.
//
//  Tool allow-listing happens twice for defense-in-depth:
//    1. We pass `tool_configuration.allowed_tools` to Anthropic.
//       Their MCP connector enforces it server-side before
//       calling the upstream MCP server.
//    2. After the response comes back, we audit every
//       `mcp_tool_use` block via `enforceMcpToolAccess` to flag
//       any drift between our intent and what was actually
//       called — see agent.ts for the audit emission.
//
//  Glob support: per-role allow-lists may contain `wiz_get_*`-
//  style patterns. They're expanded against the Wiz tool
//  catalogue (`WIZ_TOOL_CATALOGUE` below) at request time
//  because Anthropic's MCP connector requires literal tool
//  names in `allowed_tools`. The catalogue is the source of
//  truth for "what Wiz tools exist" — when Wiz publishes new
//  tools, operators extend the catalogue constant.
// ─────────────────────────────────────────────────────────────

import { env } from "./config";
import { getToolSecret } from "./secrets";
import { logger } from "./logger";
import type { Role } from "./permissions";
import {
  matchesAllowedTools,
  expandPatternsAgainstCatalogue,
} from "./mcp-tool-matcher";

// ─────────────────────────────────────────────────────────────
//  Wiz tool catalogue
//
//  These are the Wiz MCP tool names we currently know about
//  (read tools + the higher-privilege Defend/blast-radius
//  reads). When Wiz publishes new tools, extend this list and
//  add a matching mock fixture in `mcp-fixtures.ts`.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  Wiz host allowlist
//
//  Anthropic's MCP connector forwards the bearer token in our
//  request to whatever host we hand it. Without an allowlist, an
//  operator with Key Vault / env-var write access could redirect
//  WIZ_MCP_URL to an attacker-controlled HTTPS server and capture
//  both the token and every model-generated tool argument. Mirror
//  the TL_INSTANCE_RE pattern in executors.ts — exported so the
//  integration test probe (route.ts) applies the identical guard.
//
//  The default matches Wiz's hosted SaaS hostnames (anything ending
//  in `.wiz.io`). If Wiz adds a new top-level domain or your
//  deployment uses a private host, extend this regex — do NOT
//  remove the host check.
// ─────────────────────────────────────────────────────────────

export const WIZ_ALLOWED_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.wiz\.io$/i;

export const WIZ_TOOL_CATALOGUE = [
  "wiz_get_issues",
  "wiz_get_vulnerabilities",
  "wiz_get_compliance",
  "wiz_list_cloud_resources",
  "wiz_search_security_graph",
  "wiz_get_defend_threat",
  "wiz_get_blast_radius",
] as const;

export type WizMcpToolName = (typeof WIZ_TOOL_CATALOGUE)[number];

// ─────────────────────────────────────────────────────────────
//  Per-role allow-list patterns
//
//  Maps existing roles (admin / reader / triage) to the glob
//  patterns each is permitted to invoke. The patterns are
//  expanded against `WIZ_TOOL_CATALOGUE` at request time.
//
//  - admin     → full Wiz access (read + write). Remediation
//                tools are still gated by Neo's existing
//                destructive-action confirmation flow when they
//                land — for now Wiz exposes read-only tools.
//  - reader    → glob-scoped read-only (issues, vulns,
//                compliance, cloud resources, security graph).
//                No Defend, no blast-radius.
//  - triage    → identical to reader. Logic Apps acting through
//                the triage role inherit the same scoping.
// ─────────────────────────────────────────────────────────────

const WIZ_TOOL_PATTERNS_BY_ROLE: Record<Role, string[] | undefined> = {
  admin: undefined, // undefined ⇒ all catalogue tools allowed
  reader: [
    "wiz_get_issues",
    "wiz_get_vulnerabilities",
    "wiz_get_compliance",
    "wiz_list_cloud_resources",
    "wiz_search_security_graph",
  ],
  triage: [
    "wiz_get_issues",
    "wiz_get_vulnerabilities",
    "wiz_get_compliance",
    "wiz_list_cloud_resources",
    "wiz_search_security_graph",
  ],
};

// ─────────────────────────────────────────────────────────────
//  Public shape
// ─────────────────────────────────────────────────────────────

/**
 * Wire shape passed to Anthropic's `beta.messages.create` under
 * the `mcp_servers` parameter. Mirrors
 * `Anthropic.Beta.BetaRequestMCPServerURLDefinition` so the
 * agent loop can spread it directly into the SDK call.
 */
export interface McpServerConfig {
  type: "url";
  name: string;
  url: string;
  authorization_token?: string;
  tool_configuration?: {
    allowed_tools?: string[];
  };
}

/**
 * Internal metadata kept alongside each registry entry so the
 * agent loop's audit pipeline knows the human-readable server
 * name and the canonical role → patterns map. Not sent to
 * Anthropic.
 */
interface McpRegistryEntry {
  name: string;
  allowedRoles: Role[];
  patternsByRole: Record<Role, string[] | undefined>;
  catalogue: readonly string[];
  /** Reads the bearer token. Returns `undefined` to signal
   *  "credentials missing" — callers degrade gracefully. */
  getToken: () => Promise<string | undefined>;
  /** Reads the live server URL (or the mock-mode sentinel). */
  getUrl: () => Promise<string | undefined>;
}

// ─────────────────────────────────────────────────────────────
//  Registry — currently single-entry (Wiz)
//
//  Mock-mode behaviour: Wiz is unconditionally skipped when
//  `env.MOCK_MODE` is true. A previous iteration of this module
//  generated a `localhost:65535` sentinel URL meant to be paired
//  with an in-process fixture short-circuit (see mcp-fixtures.ts
//  in earlier review iterations). The fixture wiring is non-
//  trivial and has been deferred to a follow-up — until then,
//  shipping the sentinel would just hand Anthropic an unreachable
//  URL and produce error responses on every turn.
//  TODO: when fixtures land, restore the WIZ_MCP_URL-opt-in path
//  here so contributors can exercise the MCP code without a real
//  Wiz tenant.
// ─────────────────────────────────────────────────────────────

const WIZ_ENTRY: McpRegistryEntry = {
  name: "wiz",
  allowedRoles: ["admin", "reader", "triage"],
  patternsByRole: WIZ_TOOL_PATTERNS_BY_ROLE,
  catalogue: WIZ_TOOL_CATALOGUE,
  getToken: async () => {
    if (env.MOCK_MODE) return undefined; // see TODO above
    return getToolSecret("WIZ_MCP_TOKEN");
  },
  getUrl: async () => {
    if (env.MOCK_MODE) return undefined; // see TODO above
    return getToolSecret("WIZ_MCP_URL");
  },
};

const REGISTRY: McpRegistryEntry[] = [WIZ_ENTRY];

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the MCP servers the agent loop should announce on the
 * next Anthropic call for the given role. Each entry already
 * has its bearer token attached and its `allowed_tools` array
 * expanded to literal names — the caller can spread the result
 * straight into `beta.messages.create`'s `mcp_servers` param.
 *
 * Never throws. A missing URL or token produces a warning log
 * and an empty array (fail-open posture matching the existing
 * triage-dispatch failure mode).
 */
export async function getMcpServers(role: Role): Promise<McpServerConfig[]> {
  const out: McpServerConfig[] = [];
  for (const entry of REGISTRY) {
    if (!entry.allowedRoles.includes(role)) continue;

    let url: string | undefined;
    let token: string | undefined;
    try {
      url = await entry.getUrl();
      token = await entry.getToken();
    } catch (err) {
      logger.warn(
        "mcp-servers: credential lookup failed — skipping server",
        "mcp-servers",
        {
          mcpServer: entry.name,
          role,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      );
      continue;
    }

    if (!url || !token) {
      // Quiet degradation: an unconfigured server is normal in
      // dev / pre-deployment environments. Don't log a warning
      // on every turn.
      continue;
    }

    // Runtime HTTPS enforcement. Without this, a misconfigured
    // WIZ_MCP_URL of the form `http://...` would ship the bearer
    // token in plaintext to Anthropic's MCP connector, which
    // forwards it to the upstream server unchanged. The probe
    // endpoint validates this up front, but the production agent
    // path didn't until now — see security review B3.
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(url);
    } catch {
      logger.error(
        "mcp-servers: invalid URL syntax — skipping server",
        "mcp-servers",
        { mcpServer: entry.name, role },
      );
      continue;
    }
    if (parsedUrl.protocol !== "https:") {
      logger.error(
        "mcp-servers: non-https URL — refusing to send bearer token in plaintext",
        "mcp-servers",
        {
          mcpServer: entry.name,
          role,
          protocol: parsedUrl.protocol,
        },
      );
      continue;
    }

    // SECURITY: enforce a strict host allowlist. Without this, anyone
    // who can write to Key Vault or the env can redirect the bearer
    // token + tool arguments to an attacker-controlled HTTPS host.
    // See WIZ_ALLOWED_HOST_RE comment above.
    if (entry.name === "wiz" && !WIZ_ALLOWED_HOST_RE.test(parsedUrl.hostname)) {
      logger.error(
        "mcp-servers: WIZ_MCP_URL host not in allowlist — skipping server",
        "mcp-servers",
        {
          mcpServer: entry.name,
          role,
          hostname: parsedUrl.hostname,
        },
      );
      continue;
    }

    const patterns = entry.patternsByRole[role];
    const allowed_tools = expandPatternsAgainstCatalogue(patterns, entry.catalogue);

    // Defensive: if the role's pattern list was non-empty but the
    // expansion produced no literal matches, surface that as a
    // typo / stale catalogue rather than silently denying every
    // tool on the next turn. Server still ships (empty allow-list
    // is a valid "deny all" signal to Anthropic), but the warn
    // gives operators a breadcrumb when "wiz suddenly returns
    // nothing" reports come in. See review N2.
    if (
      patterns !== undefined &&
      patterns.length > 0 &&
      (allowed_tools === undefined || allowed_tools.length === 0)
    ) {
      logger.warn(
        "mcp-servers: allow-list patterns expanded to zero catalogue tools (likely typo or stale catalogue)",
        "mcp-servers",
        {
          mcpServer: entry.name,
          role,
          patterns,
          catalogueSize: entry.catalogue.length,
        },
      );
    }

    const config: McpServerConfig = {
      type: "url",
      name: entry.name,
      url,
      authorization_token: token,
    };
    if (allowed_tools !== undefined) {
      config.tool_configuration = { allowed_tools };
    }
    out.push(config);
  }
  return out;
}

/**
 * Defense-in-depth audit check. Anthropic's MCP connector
 * enforces the `tool_configuration.allowed_tools` list server-
 * side, so this should never return `false` in practice — but
 * if it ever does, that's a sign of API behaviour drift or
 * a stale catalogue, and the audit pipeline raises a warning.
 */
export function enforceMcpToolAccess(
  role: Role,
  mcpServerName: string,
  toolName: string,
): boolean {
  const entry = REGISTRY.find((e) => e.name === mcpServerName);
  if (!entry) return false;
  if (!entry.allowedRoles.includes(role)) return false;
  const patterns = entry.patternsByRole[role];
  if (patterns === undefined) {
    // "allow-all" for admin is still bounded by the known catalogue.
    // If Anthropic ever invokes a tool name that isn't catalogued
    // (a new Wiz tool we haven't documented yet, an SDK rename, or
    // adversarial drift), the audit pipeline records the divergence
    // instead of waving it through silently. See review M5.
    return entry.catalogue.includes(toolName);
  }
  return matchesAllowedTools(toolName, patterns);
}

