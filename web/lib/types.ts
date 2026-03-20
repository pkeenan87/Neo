import type Anthropic from "@anthropic-ai/sdk";
import type { Role } from "./permissions";

// ─────────────────────────────────────────────────────────────
//  Skills
// ─────────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  requiredTools: string[];
  requiredRole: Role;
  parameters: string[];
}

export type SkillMeta = Omit<Skill, "instructions">;

// ─────────────────────────────────────────────────────────────
//  Environment
// ─────────────────────────────────────────────────────────────

export interface EnvConfig {
  ANTHROPIC_API_KEY: string | undefined;
  AZURE_TENANT_ID: string | undefined;
  AZURE_CLIENT_ID: string | undefined;
  AZURE_CLIENT_SECRET: string | undefined;
  AZURE_SUBSCRIPTION_ID: string | undefined;
  SENTINEL_WORKSPACE_ID: string | undefined;
  SENTINEL_WORKSPACE_NAME: string | undefined;
  SENTINEL_RG: string | undefined;
  MOCK_MODE: boolean;
  MICROSOFT_APP_ID: string | undefined;
  MICROSOFT_APP_PASSWORD: string | undefined;
  TEAMS_BOT_ROLE: Role;
  EVENT_HUB_CONNECTION_STRING: string | undefined;
  EVENT_HUB_NAME: string | undefined;
  LOG_LEVEL: string | undefined;
  COSMOS_ENDPOINT: string | undefined;
  CLI_STORAGE_ACCOUNT: string | undefined;
  CLI_STORAGE_CONTAINER: string;
  KEY_VAULT_URL: string | undefined;
  KEY_VAULT_KEY_NAME: string;
}

// ─────────────────────────────────────────────────────────────
//  Integrations
// ─────────────────────────────────────────────────────────────

export interface IntegrationSecret {
  key: string;
  label: string;
  description: string;
  required: boolean;
}

export interface IntegrationInfo {
  slug: string;
  name: string;
  iconName: string;
  imageSrc?: string;
  description: string;
  capabilities: string[];
  secrets: IntegrationSecret[];
}

// ─────────────────────────────────────────────────────────────
//  NDJSON Agent Events
// ─────────────────────────────────────────────────────────────

export type AgentEventType =
  | "session"
  | "thinking"
  | "tool_call"
  | "confirmation_required"
  | "response"
  | "error"
  | "warning"
  | "context_trimmed"
  | "skill_invocation";

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "thinking" }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "confirmation_required"; tool: PendingTool }
  | { type: "response"; text: string }
  | { type: "error"; message: string; code?: string }
  | { type: "warning"; message: string; code: string }
  | { type: "context_trimmed"; originalTokens: number; newTokens: number; method: "truncation" | "summary" }
  | { type: "usage"; usage: TokenUsage; model: ModelPreference }
  | { type: "skill_invocation"; skill: { id: string; name: string } };

// ─────────────────────────────────────────────────────────────
//  Session
// ─────────────────────────────────────────────────────────────

export type Message = Anthropic.Messages.MessageParam;

export interface PendingTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Session {
  id: string;
  role: Role;
  ownerId: string;
  messages: Message[];
  createdAt: Date;
  lastActivityAt: Date;
  messageCount: number;
  pendingConfirmation: PendingTool | null;
}

export interface SessionMeta {
  id: string;
  role: Role;
  ownerId: string;
  createdAt: Date;
  messageCount: number;
}

// ─────────────────────────────────────────────────────────────
//  Conversation (Cosmos DB persistence)
// ─────────────────────────────────────────────────────────────

export const CHANNELS = ["web", "cli", "teams"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: string | null | undefined): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export interface Conversation {
  id: string;
  ownerId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  role: Role;
  channel: Channel;
  messages: Message[];
  pendingConfirmation: PendingTool | null;
  model?: string;
  ttl?: number;
}

export type ConversationMeta = Omit<Conversation, "messages" | "pendingConfirmation">;

// ─────────────────────────────────────────────────────────────
//  Teams Mapping (Cosmos DB persistence)
// ─────────────────────────────────────────────────────────────

export type TeamsChannelType = "thread" | "dm";

export interface TeamsMapping {
  id: string;
  sessionId: string;
  channelType: TeamsChannelType;
  teamId: string | null;
  createdAt: string;
  lastActivityAt: string;
  ttl?: number;
}

// ─────────────────────────────────────────────────────────────
//  Request / Response
// ─────────────────────────────────────────────────────────────

export interface AgentRequest {
  sessionId?: string;
  message: string;
  channel?: Channel;
  model?: ModelPreference;
}

export interface ConfirmRequest {
  sessionId: string;
  toolId: string;
  confirmed: boolean;
}

export type AgentLoopResult =
  | { type: "response"; text: string; messages: Message[] }
  | { type: "confirmation_required"; tool: PendingTool; messages: Message[] };

// ─────────────────────────────────────────────────────────────
//  Agent Callbacks
// ─────────────────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking?: () => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  /**
   * Fired each time context is trimmed within a single agent loop run.
   * May fire multiple times if truncation recurs on subsequent turns.
   */
  onContextTrimmed?: (originalTokens: number, newTokens: number, method: "truncation" | "summary") => void;
  onUsage?: (usage: TokenUsage, model: ModelPreference) => void;
}

// ─────────────────────────────────────────────────────────────
//  Executor Input Types
// ─────────────────────────────────────────────────────────────

export interface SentinelKqlInput {
  query: string;
  timespan?: string;
  description: string;
}

export interface SentinelIncidentsInput {
  severity?: "High" | "Medium" | "Low" | "Informational";
  status?: "New" | "Active" | "Closed";
  limit?: number;
}

export interface XdrAlertInput {
  alert_id: string;
  platform: "defender" | "crowdstrike";
}

export interface XdrHostSearchInput {
  hostname: string;
  platform: "defender" | "crowdstrike";
  hours?: number;
}

export interface UserInfoInput {
  upn: string;
}

export interface ResetPasswordInput {
  upn: string;
  revoke_sessions?: boolean;
  justification: string;
}

export interface IsolateMachineInput {
  hostname: string;
  machine_id?: string;
  platform: "defender" | "crowdstrike";
  isolation_type?: "Full" | "Selective";
  justification: string;
}

export interface UnisolateMachineInput {
  hostname: string;
  platform: "defender" | "crowdstrike";
  justification: string;
}

export interface MachineIsolationStatusInput {
  hostname: string;
  machine_id?: string;
}

export interface GetFullToolResultInput {
  tool_use_id: string;
}

// ─────────────────────────────────────────────────────────────
//  Model Selection
// ─────────────────────────────────────────────────────────────

// Model IDs are configurable via env vars, so this accepts any string.
export type ModelPreference = string;

// ─────────────────────────────────────────────────────────────
//  Token Usage Tracking
// ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface UsageRecord {
  id: string;
  userId: string;
  sessionId: string;
  model: string;
  usage: TokenUsage;
  timestamp: string;
  ttl: number;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  callCount: number;
  estimatedCostUsd: number;
}
