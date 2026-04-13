import type Anthropic from "@anthropic-ai/sdk";
import { TOOLS, DESTRUCTIVE_TOOLS } from "./tools";

// ─────────────────────────────────────────────────────────────
//  Roles
// ─────────────────────────────────────────────────────────────

export type Role = "admin" | "reader" | "triage";

interface RolePermissions {
  canUseDestructiveTools: boolean;
}

const ROLE_PERMISSIONS: Record<Role, RolePermissions> = {
  admin: { canUseDestructiveTools: true },
  reader: { canUseDestructiveTools: false },
  triage: { canUseDestructiveTools: false },
};

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
  if (!DESTRUCTIVE_TOOLS.has(toolName)) return true;
  return ROLE_PERMISSIONS[role].canUseDestructiveTools;
}

export function getToolsForRole(role: Role): Anthropic.Messages.Tool[] {
  if (ROLE_PERMISSIONS[role].canUseDestructiveTools) {
    return TOOLS;
  }
  return TOOLS.filter((tool) => !DESTRUCTIVE_TOOLS.has(tool.name));
}
