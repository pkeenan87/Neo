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
  ENABLE_USAGE_LIMITS: boolean;
  MICROSOFT_APP_ID: string | undefined;
  MICROSOFT_APP_PASSWORD: string | undefined;
  TEAMS_BOT_ROLE: Role;
  EVENT_HUB_CONNECTION_STRING: string | undefined;
  EVENT_HUB_NAME: string | undefined;
  EVENT_HUB_ANALYTICS_CONNECTION_STRING: string | undefined;
  EVENT_HUB_ANALYTICS_NAME: string | undefined;
  UPLOAD_STORAGE_CONTAINER: string | undefined;
  CSV_UPLOAD_STORAGE_CONTAINER: string;
  LOG_LEVEL: string | undefined;
  COSMOS_ENDPOINT: string | undefined;
  CLI_STORAGE_ACCOUNT: string | undefined;
  CLI_STORAGE_CONTAINER: string;
  KEY_VAULT_URL: string | undefined;
  KEY_VAULT_KEY_NAME: string;
  // Triage API
  TRIAGE_DEDUP_WINDOW_MS: number;
  TRIAGE_CONFIDENCE_THRESHOLD: number;
  TRIAGE_SEVERITY_ALLOWLIST: string;
  TRIAGE_CIRCUIT_BREAKER_THRESHOLD: number;
  TRIAGE_CIRCUIT_BREAKER_WINDOW_MS: number;
  TRIAGE_CIRCUIT_BREAKER_COOLDOWN_MS: number;
  TRIAGE_CALLER_ALLOWLIST: string;
  TRIAGE_RAW_PAYLOAD_MAX_BYTES: number;
}

// ─────────────────────────────────────────────────────────────
//  File Uploads
// ─────────────────────────────────────────────────────────────

export const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const ACCEPTED_DOC_TYPES = new Set([
  "application/pdf",
]);

export const ACCEPTED_CSV_TYPES = new Set([
  "text/csv",
  // Browsers are unreliable about CSV MIME types — these are common fallbacks
  "application/csv",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

export const ACCEPTED_TXT_TYPES = new Set([
  "text/plain",
]);

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
export const MAX_DOC_SIZE = 32 * 1024 * 1024;   // 32 MB
export const MAX_CSV_SIZE = 50 * 1024 * 1024;   // 50 MB
export const MAX_TXT_SIZE = 2 * 1024 * 1024;    // 2 MB
export const MAX_FILES_PER_MESSAGE = 5;

// ── CSV classification thresholds ────────────────────────────
// Both thresholds must be satisfied for the inline path: a CSV can
// hit the row cap cheaply but still be too large on bytes (wide
// columns), or vice versa.
export const CSV_INLINE_ROW_LIMIT = 500;
export const CSV_INLINE_BYTE_LIMIT = 100_000; // ~100 KB
export const CSV_MAX_REFERENCE_ATTACHMENTS = 10;
export const CSV_PREVIEW_ROW_COUNT = 5;
export const CSV_QUERY_RESULT_LIMIT = 100;
// Hard ceiling on column count. Wide CSVs with thousands of columns
// would push the Cosmos document past its 2 MB item limit once their
// preview rows are persisted — so we reject them at classify time.
export const CSV_MAX_COLUMNS = 200;
// Maximum character length for any single preview cell before it is
// truncated (with a trailing ellipsis). Only affects previewRows that
// end up in the Cosmos document; the full-fidelity body still lives in
// blob storage for reference-mode CSVs.
export const CSV_PREVIEW_CELL_MAX_CHARS = 500;

export interface FileAttachment {
  filename: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  blobUrl?: string;
}

export interface FileRef {
  filename: string;
  mimetype: string;
  blobUrl: string;
}

// ── CSV Attachments ──────────────────────────────────────────

/**
 * A reference-mode CSV attachment persisted on the conversation document.
 * The full CSV body lives in Azure Blob Storage; queries go through the
 * `query_csv` tool which downloads the blob and loads it into an
 * in-memory SQLite database per call.
 */
export interface CSVReference {
  csvId: string;
  filename: string;
  blobUrl: string;
  rowCount: number;
  columns: string[];
  sampleRows: string[][];
  createdAt: string;
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
  | "session_ended"
  | "session_interrupted";

export interface LogIdentityContext {
  userName: string;
  userIdHash: string;
  role: string;
  provider: "entra-id" | "api-key" | "service-principal";
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
  | "tool_result"
  | "confirmation_required"
  | "response"
  | "error"
  | "warning"
  | "context_trimmed"
  | "skill_invocation"
  | "interrupted";

/**
 * Captured record of a single tool execution — input, output, duration.
 * Streamed to the UI via `tool_result` events so the chat can render an
 * expandable "raw data" trace under an assistant message. durationMs is
 * only populated during live streaming; on reload it may be undefined
 * (we can reconstruct input/output from persisted message blocks but
 * wall-clock duration isn't persisted).
 */
export interface ToolTrace {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs?: number;
  isError?: boolean;
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "thinking" }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; input: Record<string, unknown>; output: unknown; durationMs: number; isError?: boolean }
  | { type: "confirmation_required"; tool: PendingTool }
  | { type: "response"; text: string; interrupted?: boolean }
  | { type: "error"; message: string; code?: string }
  | { type: "warning"; message: string; code: string }
  | { type: "context_trimmed"; originalTokens: number; newTokens: number; method: "truncation" | "summary" }
  | { type: "usage"; usage: TokenUsage; model: ModelPreference }
  | { type: "skill_invocation"; skill: { id: string; name: string } }
  | { type: "interrupted" };

// ─────────────────────────────────────────────────────────────
//  Session
// ─────────────────────────────────────────────────────────────

export type Message = Anthropic.Messages.MessageParam;

export interface PendingTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Tool results from the same assistant turn that ran successfully BEFORE
   * the destructive tool paused the loop. On resume, these are emitted
   * alongside the confirmed/cancelled result so every `tool_use` block in
   * the assistant message has a matching `tool_result`.
   *
   * Optional for backward compatibility with older persisted
   * pendingConfirmation values in Cosmos (pre-fix conversations).
   */
  preExecutedResults?: Anthropic.Messages.ToolResultBlockParam[];
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
  csvAttachments?: CSVReference[];
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
  | { type: "response"; text: string; messages: Message[]; interrupted?: boolean }
  | { type: "confirmation_required"; tool: PendingTool; messages: Message[] };

// ─────────────────────────────────────────────────────────────
//  Agent Callbacks
// ─────────────────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking?: () => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  /**
   * Fired after each tool execution completes (success or error). Carries
   * the full input + output + wall-clock duration so the UI can render an
   * expandable raw-data trace under the assistant message.
   */
  onToolResult?: (trace: ToolTrace) => void;
  /**
   * Fired each time context is trimmed within a single agent loop run.
   * May fire multiple times if truncation recurs on subsequent turns.
   */
  onContextTrimmed?: (originalTokens: number, newTokens: number, method: "truncation" | "summary") => void;
  onUsage?: (usage: TokenUsage, model: ModelPreference) => void;
  /**
   * Fired after each agent loop turn — when an assistant response or tool
   * results are appended to the message array. Use to incrementally persist
   * messages so conversations are not lost on disconnect or error.
   */
  onTurnComplete?: (messages: Message[]) => void;
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

export interface QueryCsvInput {
  csv_id: string;
  query: string;
}

export class CsvAttachmentCapError extends Error {
  constructor(public readonly cap: number) {
    super(`CSV attachment limit reached: a conversation can hold at most ${cap} reference-mode CSV attachments. Please start a new conversation.`);
    this.name = "CsvAttachmentCapError";
  }
}

// ─────────────────────────────────────────────────────────────
//  Triage API
// ─────────────────────────────────────────────────────────────

export type TriageVerdict = "benign" | "escalate" | "inconclusive";

export type TriageAlertSeverity = "Informational" | "Low" | "Medium" | "High";

export type TriageProduct =
  | "DefenderXDR"
  | "Sentinel"
  | "EntraIDProtection"
  | "Purview"
  | "DefenderForCloudApps";

export interface TriageSource {
  product: TriageProduct;
  alertType: string;
  severity: TriageAlertSeverity;
  tenantId: string;
  alertId: string;
  detectionTime: string;
}

export interface TriageEntities {
  users?: string[];
  devices?: string[];
  ips?: string[];
  files?: { name: string; sha256?: string }[];
  urls?: string[];
  processes?: string[];
}

export interface TriageEssentials {
  title: string;
  description: string;
  entities: TriageEntities;
  mitreTactics?: string[];
  evidence?: unknown[];
}

export interface TriagePayload {
  essentials: TriageEssentials;
  raw?: Record<string, unknown>;
  links?: {
    portalUrl?: string;
    investigationGraphUrl?: string;
  };
}

export interface TriageContext {
  requesterId: string;
  playbookRunId?: string;
  dryRun?: boolean;
  analystNotes?: string;
}

export interface TriageRequest {
  source: TriageSource;
  payload: TriagePayload;
  context: TriageContext;
}

export interface TriageEvidence {
  source: string;
  query?: string;
  finding: string;
}

export interface TriageRecommendedAction {
  action: string;
  reason: string;
}

export interface TriageResponse {
  verdict: TriageVerdict;
  confidence: number;
  reasoning: string;
  evidence: TriageEvidence[];
  recommendedActions: TriageRecommendedAction[];
  neoRunId: string;
  skillUsed: string;
  durationMs: number;
  dryRun?: boolean;
  /** Set when guardrails override the original verdict. */
  originalVerdict?: TriageVerdict;
  originalConfidence?: number;
  /** Reason code when the response is a fail-safe or system-generated verdict. */
  reason?: string;
}

export interface TriageRun {
  id: string;
  alertId: string;
  request: TriageRequest;
  response?: TriageResponse;
  rawClaudeResponse?: string;
  toolCallTrace?: unknown[];
  callerId: string;
  createdAt: string;
  durationMs?: number;
  ttl: number;
}

// ── Triage Config Constants ──────────────────────────────────
export const TRIAGE_DEFAULT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const TRIAGE_DEFAULT_CONFIDENCE_THRESHOLD = 0.80;
export const TRIAGE_DEFAULT_SEVERITY_ALLOWLIST: TriageAlertSeverity[] = [
  "Informational", "Low", "Medium", "High",
];
export const TRIAGE_DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 0.30;
export const TRIAGE_DEFAULT_CIRCUIT_BREAKER_WINDOW_MS = 15 * 60 * 1000; // 15 min
export const TRIAGE_DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
export const TRIAGE_DEFAULT_RAW_PAYLOAD_MAX_BYTES = 500_000; // 500 KB
export const TRIAGE_RUN_TTL = 7_776_000; // 90 days

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
