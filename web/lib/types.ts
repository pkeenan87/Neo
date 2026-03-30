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
  EVENT_HUB_ANALYTICS_CONNECTION_STRING: string | undefined;
  EVENT_HUB_ANALYTICS_NAME: string | undefined;
  LOG_LEVEL: string | undefined;
  COSMOS_ENDPOINT: string | undefined;
  CLI_STORAGE_ACCOUNT: string | undefined;
  CLI_STORAGE_CONTAINER: string;
  KEY_VAULT_URL: string | undefined;
  KEY_VAULT_KEY_NAME: string;
}

// ─────────────────────────────────────────────────────────────
//  Logging
// ─────────────────────────────────────────────────────────────

export type LogEventType =
  | "operational"
  | "tool_execution"
  | "token_usage"
  | "skill_invocation"
  | "destructive_action"
  | "budget_alert"
  | "session_started"
  | "session_ended";

export interface LogIdentityContext {
  userName: string;
  userIdHash: string;
  role: string;
  provider: "entra-id" | "api-key";
  channel: string;
  sessionId: string;
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

export interface DismissUserRiskInput {
  upn: string;
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

export interface SearchUserMessagesInput {
  upn: string;
  sender?: string;
  subject?: string;
  search_text?: string;
  days?: number;
}

export interface ReportMessageAsPhishingInput {
  upn: string;
  message_id: string;
  report_type?: "phishing" | "junk";
  justification: string;
}

export interface ListThreatLockerApprovalsInput {
  status?: "pending" | "approved" | "ignored";
  search_text?: string;
  page?: number;
  page_size?: number;
}

export interface GetThreatLockerApprovalInput {
  approval_request_id: string;
}

export interface ApproveThreatLockerRequestInput {
  approval_request_id: string;
  policy_level?: "computer" | "group" | "organization";
  justification: string;
}

export interface DenyThreatLockerRequestInput {
  approval_request_id: string;
  justification: string;
}

export type IndicatorType = "domain" | "ip" | "url" | "sha1" | "sha256" | "md5" | "cert";
export type IndicatorAction = "block" | "warn" | "audit";
export type IndicatorSeverity = "informational" | "low" | "medium" | "high";

export interface BlockIndicatorInput {
  value: string;
  indicator_type: IndicatorType;
  action?: IndicatorAction;
  title: string;
  description?: string;
  severity?: IndicatorSeverity;
  expiration?: string;
  generate_alert?: boolean;
}

export interface ImportIndicatorsInput {
  indicators: {
    value: string;
    indicator_type: IndicatorType;
    action?: IndicatorAction;
    title: string;
    severity?: IndicatorSeverity;
  }[];
  description?: string;
  expiration?: string;
}

export interface ListIndicatorsInput {
  indicator_type?: IndicatorType;
  top?: number;
}

export interface DeleteIndicatorInput {
  indicator_id: number;
  justification: string;
}

export interface LookupAssetInput {
  search: string;
  search_type?: "name" | "ip" | "serial";
}

export interface SearchAbnormalMessagesInput {
  sender_email?: string;
  sender_name?: string;
  recipient_email?: string;
  subject?: string;
  attachment_name?: string;
  attachment_md5_hash?: string;
  body_link?: string;
  sender_ip?: string;
  judgement?: "attack" | "borderline" | "spam" | "graymail" | "safe";
  source?: "abnormal" | "quarantine";
  start_time?: string;
  end_time?: string;
  page_number?: number;
  page_size?: number;
}

export interface RemediateAbnormalMessagesInput {
  action: "delete" | "move_to_inbox" | "submit_to_d360";
  remediation_reason: "false_negative" | "misdirected" | "unsolicited" | "other";
  messages?: { message_id: string; recipient_email: string }[];
  remediate_all?: boolean;
  search_filters?: Omit<SearchAbnormalMessagesInput, "page_number" | "page_size">;
  justification: string;
}

export interface GetAbnormalRemediationStatusInput {
  activity_log_id: string;
}

export interface GetVendorRiskInput {
  vendor_domain: string;
}

export interface ListVendorsInput {
  page_size?: number;
  page_number?: number;
}

export interface GetVendorActivityInput {
  vendor_domain: string;
  page_size?: number;
  page_number?: number;
}

export interface ListVendorCasesInput {
  filter?: "firstObservedTime" | "lastModifiedTime";
  filter_value?: string;
}

export interface GetVendorCaseInput {
  case_id: string;
}

export interface GetEmployeeProfileInput {
  email: string;
}

export interface GetEmployeeLoginHistoryInput {
  email: string;
}

export interface ListAbnormalThreatsInput {
  start_time?: string;
  end_time?: string;
  page_size?: number;
  page_number?: number;
}

export interface GetAbnormalThreatInput {
  threat_id: string;
}

export interface ListAtoCasesInput {
  filter_value?: string;
  page_size?: number;
  page_number?: number;
}

export interface GetAtoCaseInput {
  case_id: string;
}

export interface ActionAtoCaseInput {
  case_id: string;
  action: "action_required" | "acknowledge";
  justification: string;
}

export interface ListCaPoliciesInput {
  resolve_names?: boolean;
}

export interface GetCaPolicyInput {
  policy_id: string;
  resolve_names?: boolean;
}

export interface ListNamedLocationsInput {
  // no required params
}

export interface SearchThreatLockerComputersInput {
  search_text: string;
  search_by?: "name" | "username" | "ip";
  page_size?: number;
}

export interface GetThreatLockerComputerInput {
  computer_id: string;
}

export type MaintenanceMode = "learning" | "installation" | "monitor" | "secured" | "network_monitor" | "storage_monitor";
export type BulkMaintenanceMode = "learning" | "installation" | "monitor" | "disable_tamper";

export interface SetMaintenanceModeInput {
  computer_id: string;
  organization_id: string;
  mode: MaintenanceMode;
  duration_hours?: number;
  end_time?: string;
  learning_type?: "autocomp" | "autogroup" | "autosystem";
}

export interface ScheduleBulkMaintenanceInput {
  computers: { computer_id: string; organization_id: string; computer_group_id: string }[];
  mode: BulkMaintenanceMode;
  start_time: string;
  end_time: string;
  permit_end?: boolean;
}

export interface EnableSecuredModeInput {
  computers: { computer_id: string; organization_id: string }[];
}

// ── AppOmni Input Types ──────────────────────────────────────

export interface ListAppOmniServicesInput {
  service_type?: string;
  search?: string;
  score_gte?: number;
  score_lte?: number;
  limit?: number;
  offset?: number;
}

export interface GetAppOmniServiceInput {
  service_id: number;
  service_type: string;
}

export type FindingDetailedStatus = "new" | "in_research" | "in_remediation" | "done";
export type ExceptionReason = "risk_accepted" | "false_positive" | "compensating_controls" | "not_applicable" | "confirmed_intended";

export interface ListAppOmniFindingsInput {
  status?: "open" | "closed";
  risk_score_gte?: number;
  risk_score_lte?: number;
  monitored_service_ids?: number[];
  category?: string;
  compliance_framework?: string;
  source_type?: "scanner" | "insight";
  first_opened_gte?: string;
  first_opened_lte?: string;
  limit?: number;
  offset?: number;
}

export interface GetAppOmniFindingInput {
  finding_id: string;
}

export interface ListAppOmniFindingOccurrencesInput {
  finding_id?: string;
  status?: "open" | "closed";
  detailed_status?: FindingDetailedStatus;
  monitored_service_ids?: number[];
  limit?: number;
  offset?: number;
}

export interface ListAppOmniInsightsInput {
  status?: string[];
  monitored_service_ids?: number[];
  first_seen_gte?: string;
  last_seen_gte?: string;
  limit?: number;
  offset?: number;
}

export interface ListAppOmniPolicyIssuesInput {
  policy_ids?: number[];
  service_org_ids?: number[];
  service_type?: string;
  limit?: number;
  offset?: number;
}

export interface ListAppOmniIdentitiesInput {
  identity_status?: string[];
  permission_level?: string[];
  service_types?: string[];
  search?: string;
  last_login_gte?: string;
  last_login_lte?: string;
  limit?: number;
  offset?: number;
}

export interface GetAppOmniIdentityInput {
  identity_id: number;
}

export interface ListAppOmniDiscoveredAppsInput {
  status?: "approved" | "pending" | "rejected";
  criticality?: "high" | "medium" | "low";
  owner?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface GetAppOmniAuditLogsInput {
  since?: string;
  before?: string;
  action_type?: string;
  monitored_service_id?: number;
  user_id?: number;
  policy_id?: number;
  limit?: number;
  offset?: number;
}

export interface ActionAppOmniFindingInput {
  action: "update_status" | "close_exception";
  occurrence_ids: string[];
  detailed_status?: FindingDetailedStatus;
  reason?: ExceptionReason;
  expires?: string;
  message?: string;
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
