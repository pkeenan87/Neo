import type Anthropic from "@anthropic-ai/sdk";
import { TOOLS, DESTRUCTIVE_TOOLS } from "./tools";

// ─────────────────────────────────────────────────────────────
//  Roles
// ─────────────────────────────────────────────────────────────

export type Role = "admin" | "reader" | "triage";

interface RolePermissions {
  canUseDestructiveTools: boolean;
  /**
   * Per-role allowlist for read-only tools. `"all"` (the current
   * default for every role) preserves today's behaviour: any tool
   * not in DESTRUCTIVE_TOOLS is callable. A `Set<string>` would
   * narrow access to specific tool names — used as the future hook
   * for tightening triage / per-skill scopes without reshaping the
   * data model.
   */
  allowedReadOnlyTools: Set<string> | "all";
}

const ROLE_PERMISSIONS: Record<Role, RolePermissions> = {
  admin:  { canUseDestructiveTools: true,  allowedReadOnlyTools: "all" },
  reader: { canUseDestructiveTools: false, allowedReadOnlyTools: "all" },
  triage: { canUseDestructiveTools: false, allowedReadOnlyTools: "all" },
};

// Non-destructive tools that should still be admin-only. The default
// "all" allowlist above keeps every non-destructive tool reachable by
// every role, which is the right call for read-only investigative
// tools — but the Infosec notification tools dispatch to a shared
// Logic App workflow that fans out to Teams/email. Restrict to admin
// to keep proactive notifications a deliberate, audited surface.
const ADMIN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "send_teams_message",
  "send_email",
]);

// ─────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────

export class ToolPermissionError extends Error {
  constructor(public readonly role: Role, public readonly toolName: string) {
    // SECURITY: do NOT include `toolName` in the message string. The
    // agent loop's tool-error catch surfaces err.message back to the
    // model as tool_result content, which is then rendered to the
    // user. Confirming which exact tool a role can't reach helps a
    // prompt-injection probe enumerate the surface. The role + tool
    // name remain on typed properties for server-side audit only.
    super("Tool not permitted for your role.");
    this.name = "ToolPermissionError";
  }
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ─────────────────────────────────────────────────────────────
//  Rate Limits
// ─────────────────────────────────────────────────────────────

interface RateLimitConfig {
  messagesPerSession: number;
}

export const RATE_LIMITS: Record<Role, RateLimitConfig> = {
  admin: { messagesPerSession: 200 },
  reader: { messagesPerSession: 100 },
  triage: { messagesPerSession: 50 },
};

// ─────────────────────────────────────────────────────────────
//  Tool Access
// ─────────────────────────────────────────────────────────────

export function canUseTool(role: Role, toolName: string): boolean {
  // Reject unknown tool names outright. The TOOLS array is the source
  // of truth; anything else means a typo or a registry-drift bug.
  if (!TOOL_NAMES.has(toolName)) return false;

  const perms = ROLE_PERMISSIONS[role];
  if (DESTRUCTIVE_TOOLS.has(toolName)) {
    return perms.canUseDestructiveTools;
  }
  if (ADMIN_ONLY_TOOLS.has(toolName) && role !== "admin") {
    return false;
  }
  if (perms.allowedReadOnlyTools === "all") return true;
  return perms.allowedReadOnlyTools.has(toolName);
}

export function getToolsForRole(role: Role): Anthropic.Messages.Tool[] {
  const perms = ROLE_PERMISSIONS[role];
  return TOOLS.filter((tool) => {
    if (DESTRUCTIVE_TOOLS.has(tool.name)) return perms.canUseDestructiveTools;
    if (ADMIN_ONLY_TOOLS.has(tool.name) && role !== "admin") return false;
    if (perms.allowedReadOnlyTools === "all") return true;
    return perms.allowedReadOnlyTools.has(tool.name);
  });
}
