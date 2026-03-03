import type Anthropic from "@anthropic-ai/sdk";

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
  | "error";

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "thinking" }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "confirmation_required"; tool: PendingTool }
  | { type: "response"; text: string }
  | { type: "error"; message: string };

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
  messages: Message[];
  createdAt: Date;
  lastActivityAt: Date;
  messageCount: number;
  pendingConfirmation: PendingTool | null;
}

export interface SessionMeta {
  id: string;
  createdAt: Date;
  messageCount: number;
}

// ─────────────────────────────────────────────────────────────
//  Request / Response
// ─────────────────────────────────────────────────────────────

export interface AgentRequest {
  sessionId?: string;
  message: string;
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
