import { env } from "./config";
import { getAzureToken, getMSGraphToken, generateSecurePassword } from "./auth";
import { getToolSecret } from "./secrets";
import { logger, hashPii } from "./logger";
import type {
  SentinelKqlInput,
  SentinelIncidentsInput,
  XdrAlertInput,
  XdrHostSearchInput,
  UserInfoInput,
  ResetPasswordInput,
  DismissUserRiskInput,
  IsolateMachineInput,
  UnisolateMachineInput,
  MachineIsolationStatusInput,
  SearchUserMessagesInput,
  ReportMessageAsPhishingInput,
  ListThreatLockerApprovalsInput,
  GetThreatLockerApprovalInput,
  ApproveThreatLockerRequestInput,
  DenyThreatLockerRequestInput,
  BlockIndicatorInput,
  ImportIndicatorsInput,
  ListIndicatorsInput,
  DeleteIndicatorInput,
  LookupAssetInput,
  SearchAbnormalMessagesInput,
  RemediateAbnormalMessagesInput,
  GetAbnormalRemediationStatusInput,
  GetVendorRiskInput,
  ListVendorsInput,
  GetVendorActivityInput,
  ListVendorCasesInput,
  GetVendorCaseInput,
  GetEmployeeProfileInput,
  GetEmployeeLoginHistoryInput,
  ListAbnormalThreatsInput,
  GetAbnormalThreatInput,
  ListAtoCasesInput,
  GetAtoCaseInput,
  ActionAtoCaseInput,
  GetFullToolResultInput,
  Message,
} from "./types";
import type { IndicatorType } from "./types";
import {
  detectSearchType,
  extractCustomTags,
  identifyPrimaryUser,
  buildVulnSummary,
} from "./lansweeper-helpers";
import type { VulnSummary } from "./lansweeper-helpers";
import {
  validateMd5Hash,
  validateSenderEmail,
  validateSenderIp,
  validateBodyLink,
  validateActivityLogId,
  defaultTimeRange,
  validateRemediateInput,
} from "./abnormal-helpers";

// ── Input Validation Helpers ──────────────────────────────────

const VALID_SEVERITY = new Set(["High", "Medium", "Low", "Informational"]);
const VALID_STATUS = new Set(["New", "Active", "Closed"]);
const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;
const UPN_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateHostname(hostname: string): void {
  if (!HOSTNAME_RE.test(hostname)) {
    throw new Error(`Invalid hostname format: ${hostname}`);
  }
}

function validateUpn(upn: string): void {
  if (!UPN_RE.test(upn)) {
    throw new Error(`Invalid UPN format: ${upn}`);
  }
}

const MACHINE_ID_RE = /^[0-9a-f]{40}$/i;

function validateMachineId(id: string): void {
  if (!MACHINE_ID_RE.test(id)) {
    throw new Error("Invalid machine ID format");
  }
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

// ── Sentinel ──────────────────────────────────────────────────

async function run_sentinel_kql({ query, timespan = "PT24H" }: SentinelKqlInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockSentinelKql(query);
  }

  const token = await getAzureToken("https://api.loganalytics.io");
  const workspaceId = await getToolSecret("SENTINEL_WORKSPACE_ID");
  if (!workspaceId) throw new Error("Missing SENTINEL_WORKSPACE_ID. Configure via /integrations or .env");
  const res = await fetch(
    `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, timespan }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sentinel KQL query failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function get_sentinel_incidents({ severity, status = "New", limit = 10 }: SentinelIncidentsInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockSentinelIncidents();
  }

  const token = await getAzureToken("https://management.azure.com");
  const params = new URLSearchParams({ "$top": String(limit) });
  if (severity) {
    if (!VALID_SEVERITY.has(severity)) throw new Error(`Invalid severity value: ${severity}`);
    if (status && !VALID_STATUS.has(status)) throw new Error(`Invalid status value: ${status}`);
    params.set("$filter", `properties/severity eq '${escapeODataString(severity)}' and properties/status eq '${escapeODataString(status)}'`);
  }
  const subscriptionId = await getToolSecret("AZURE_SUBSCRIPTION_ID");
  const resourceGroup = await getToolSecret("SENTINEL_RESOURCE_GROUP");
  const workspaceName = await getToolSecret("SENTINEL_WORKSPACE_NAME");
  if (!subscriptionId || !resourceGroup || !workspaceName) {
    throw new Error("Missing Sentinel config. Configure via /integrations or set AZURE_SUBSCRIPTION_ID, SENTINEL_RESOURCE_GROUP, and SENTINEL_WORKSPACE_NAME in .env");
  }
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.OperationalInsights/workspaces/${workspaceName}/providers/Microsoft.SecurityInsights/incidents?api-version=2023-11-01&${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sentinel incidents query failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

// ── XDR ───────────────────────────────────────────────────────

async function get_xdr_alert({ alert_id, platform }: XdrAlertInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockXdrAlert(alert_id, platform);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const res = await fetch(
    `https://api.securitycenter.microsoft.com/api/alerts/${encodeURIComponent(alert_id)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`XDR alert lookup failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function search_xdr_by_host({ hostname, platform }: XdrHostSearchInput): Promise<unknown> {
  validateHostname(hostname);

  if (env.MOCK_MODE) {
    return mockXdrHostSearch(hostname, platform);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const res = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${escapeODataString(hostname)}'`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`XDR machine lookup failed (${res.status}): ${errText}`);
  }

  const machines = await res.json();
  const machineId = machines.value?.[0]?.id;

  if (!machineId) {
    return { hostname, platform, error: `No machine found matching hostname '${hostname}'`, alerts: [] };
  }

  const alertsRes = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines/${machineId}/alerts`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!alertsRes.ok) {
    const errText = await alertsRes.text();
    throw new Error(`XDR alerts-by-machine failed (${alertsRes.status}): ${errText}`);
  }

  const alerts = await alertsRes.json();
  return { hostname, platform, machineId, ...alerts };
}

// ── Identity ──────────────────────────────────────────────────

async function get_user_info({ upn }: UserInfoInput): Promise<unknown> {
  validateUpn(upn);

  if (env.MOCK_MODE) {
    return mockUserInfo(upn);
  }

  const token = await getMSGraphToken();
  const headers = { Authorization: `Bearer ${token}` };
  const encodedUpn = encodeURIComponent(upn);

  const [user, mfa, groups, devices, riskDetections] = await Promise.allSettled([
    fetch(`https://graph.microsoft.com/v1.0/users/${encodedUpn}?$select=displayName,jobTitle,department,accountEnabled,lastPasswordChangeDateTime,userPrincipalName`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?$filter=userPrincipalName eq '${escapeODataString(upn)}'`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/v1.0/users/${encodedUpn}/memberOf`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/v1.0/users/${encodedUpn}/registeredDevices`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/beta/identityProtection/riskDetections?$filter=userPrincipalName eq '${escapeODataString(upn)}'`, { headers }).then(r => r.json()),
  ]);

  return {
    user: user.status === "fulfilled" ? user.value : { error: (user as PromiseRejectedResult).reason?.message },
    mfa: mfa.status === "fulfilled" ? mfa.value : { error: (mfa as PromiseRejectedResult).reason?.message },
    groups: groups.status === "fulfilled" ? groups.value : { error: (groups as PromiseRejectedResult).reason?.message },
    devices: devices.status === "fulfilled" ? devices.value : { error: (devices as PromiseRejectedResult).reason?.message },
    riskDetections: riskDetections.status === "fulfilled" ? riskDetections.value : { error: (riskDetections as PromiseRejectedResult).reason?.message },
  };
}

// ── Destructive Actions ───────────────────────────────────────

async function reset_user_password({ upn, revoke_sessions = true, justification }: ResetPasswordInput): Promise<unknown> {
  validateUpn(upn);

  if (env.MOCK_MODE) {
    return mockPasswordReset(upn, revoke_sessions);
  }

  const token = await getMSGraphToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const newPassword = generateSecurePassword();

  const encodedUpn = encodeURIComponent(upn);
  const resetRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodedUpn}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      passwordProfile: {
        password: newPassword,
        forceChangePasswordNextSignIn: true,
      },
    }),
  });

  if (!resetRes.ok) {
    const errText = await resetRes.text();
    throw new Error(`Password reset failed (${resetRes.status}): ${errText}`);
  }

  let sessionRevoked = false;
  if (revoke_sessions) {
    const revokeRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodedUpn}/revokeSignInSessions`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    if (revokeRes.ok) {
      sessionRevoked = true;
    }
  }

  return {
    success: true,
    upn,
    temporaryPassword: newPassword,
    sessionRevoked,
    completedAt: new Date().toISOString(),
  };
}

async function dismiss_user_risk({ upn, justification }: DismissUserRiskInput): Promise<unknown> {
  validateUpn(upn);

  if (env.MOCK_MODE) {
    return { dismissed: true, upn, justification, _mock: true };
  }

  const token = await getMSGraphToken();
  const encodedUpn = encodeURIComponent(upn);

  // Resolve user object ID from UPN
  const userRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodedUpn}?$select=id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!userRes.ok) {
    const errText = await userRes.text();
    throw new Error(`User lookup failed (${userRes.status}): ${errText}`);
  }

  const userData = await userRes.json();
  const objectId = typeof userData.id === "string" ? userData.id : "";

  // Entra object IDs are always UUIDs — validate before using in a write operation
  if (!objectId || !GUID_RE.test(objectId)) {
    throw new Error(`No user found matching UPN '${upn}' in Entra ID, or unexpected ID format`);
  }

  // SECURITY: Using /beta endpoint — no GA SLA. Track graduation:
  // https://learn.microsoft.com/en-us/graph/api/riskyuser-dismiss
  // Requires IdentityRiskyUser.ReadWrite.All application permission.
  const res = await fetch(
    "https://graph.microsoft.com/beta/riskyUsers/dismiss",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userIds: [objectId] }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Dismiss user risk failed (${res.status}): ${errText}`);
  }

  logger.info("User risk dismissed in Entra ID", "executors", {
    toolName: "dismiss_user_risk",
    userIdHash: hashPii(upn),
  });

  return { dismissed: true, upn, justification };
}

async function isolate_machine({ hostname, machine_id, platform, isolation_type = "Full", justification }: IsolateMachineInput): Promise<unknown> {
  validateHostname(hostname);

  if (env.MOCK_MODE) {
    return mockIsolateMachine(hostname, machine_id, platform, isolation_type);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  let resolvedMachineId = machine_id;

  if (!resolvedMachineId) {
    const machineRes = await fetch(
      `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${escapeODataString(hostname)}'`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const machines = await machineRes.json();
    resolvedMachineId = machines.value?.[0]?.id;

    if (!resolvedMachineId) {
      throw new Error(`No machine found matching hostname '${hostname}' in Defender`);
    }
  }

  const res = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines/${encodeURIComponent(resolvedMachineId)}/isolate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ Comment: justification, IsolationType: isolation_type }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Machine isolation failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function unisolate_machine({ hostname, platform, justification }: UnisolateMachineInput): Promise<unknown> {
  validateHostname(hostname);

  if (env.MOCK_MODE) {
    return mockUnisolateMachine(hostname, platform);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");

  const machineRes = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${escapeODataString(hostname)}'`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const machines = await machineRes.json();
  const machineId = machines.value?.[0]?.id;

  if (!machineId) {
    throw new Error(`No machine found matching hostname '${hostname}' in Defender`);
  }

  const res = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines/${encodeURIComponent(machineId)}/unisolate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ Comment: justification }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Machine unisolation failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

// ── Machine Isolation Status ─────────────────────────────────

async function get_machine_isolation_status({ hostname, machine_id }: MachineIsolationStatusInput): Promise<unknown> {
  validateHostname(hostname);
  if (machine_id !== undefined) {
    validateMachineId(machine_id);
  }

  if (env.MOCK_MODE) {
    return mockMachineIsolationStatus(hostname, machine_id);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  let resolvedMachineId = machine_id;
  let machineHealth: Record<string, unknown> | null = null;

  // Resolve machine ID from hostname and get health data
  const machineRes = await fetch(
    resolvedMachineId
      ? `https://api.securitycenter.microsoft.com/api/machines/${encodeURIComponent(resolvedMachineId)}`
      : `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${escapeODataString(hostname)}'`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!machineRes.ok) {
    const errText = await machineRes.text();
    throw new Error(`Machine lookup failed (${machineRes.status}): ${errText}`);
  }

  const machineData = await machineRes.json();
  const machine = resolvedMachineId ? machineData : machineData.value?.[0];

  if (!machine) {
    throw new Error(`No machine found matching hostname '${hostname}' in Defender`);
  }

  const apiMachineId = machine.id as string;
  validateMachineId(apiMachineId);
  resolvedMachineId = apiMachineId;

  machineHealth = {
    healthStatus: machine.healthStatus,
    riskScore: machine.riskScore,
    exposureLevel: machine.exposureLevel,
    osPlatform: machine.osPlatform,
    osVersion: machine.osVersion,
    lastSeen: machine.lastSeen,
    lastIpAddress: machine.lastIpAddress,
  };

  // Query recent isolation/unisolation actions (type filter in OData avoids
  // non-isolation actions crowding out results within the $top limit)
  const actionsRes = await fetch(
    `https://api.securitycenter.microsoft.com/api/machineactions?$filter=machineId eq '${escapeODataString(resolvedMachineId)}' and (type eq 'Isolate' or type eq 'Unisolate')&$orderby=creationDateTimeUtc desc&$top=5`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!actionsRes.ok) {
    const errText = await actionsRes.text();
    throw new Error(`Machine actions query failed (${actionsRes.status}): ${errText}`);
  }

  const actionsData = await actionsRes.json();
  return buildIsolationResult(hostname, resolvedMachineId, actionsData.value ?? [], machineHealth);
}

function buildIsolationResult(
  hostname: string,
  machineId: string,
  isolationActions: Record<string, unknown>[],
  health: Record<string, unknown> | null,
): unknown {
  if (isolationActions.length === 0) {
    return {
      hostname,
      machineId,
      isolationStatus: "NotIsolated",
      note: "No isolation history found for this machine",
      lastAction: null,
      health,
    };
  }

  const latest = isolationActions[0];
  let isolationStatus: string;

  if (latest.type === "Isolate" && latest.status === "Succeeded") {
    isolationStatus = "Isolated";
  } else if (latest.type === "Isolate" && (latest.status === "Pending" || latest.status === "InProgress")) {
    isolationStatus = "Pending";
  } else if (latest.type === "Isolate" && latest.status === "Failed") {
    isolationStatus = "NotIsolated";
  } else if (latest.type === "Unisolate" && latest.status === "Succeeded") {
    isolationStatus = "NotIsolated";
  } else if (latest.type === "Unisolate" && (latest.status === "Pending" || latest.status === "InProgress")) {
    isolationStatus = "UnisolatePending";
  } else if (latest.type === "Unisolate" && latest.status === "Failed") {
    isolationStatus = "Isolated";
  } else {
    isolationStatus = "Unknown";
  }

  return {
    hostname,
    machineId,
    isolationStatus,
    lastAction: {
      type: latest.type,
      status: latest.status,
      requestor: latest.requestor,
      creationDateTimeUtc: latest.creationDateTimeUtc,
      lastUpdateDateTimeUtc: latest.lastUpdateDateTimeUtc,
      comment: latest.requestorComment ?? latest.title,
    },
    health,
  };
}

// ── Email Message Search & Reporting ─────────────────────────

// Graph message IDs are base64-encoded; enforce length bounds to prevent memory abuse
const MESSAGE_ID_RE = /^[A-Za-z0-9+/=_-]{10,512}$/;
const SAFE_SEARCH_RE = /^[\w\s@.\-,!?']+$/u;
const MAX_SEARCH_DAYS = 90;

async function search_user_messages({ upn, sender, subject, search_text, days = 7 }: SearchUserMessagesInput): Promise<unknown> {
  validateUpn(upn);
  if (sender && !UPN_RE.test(sender)) {
    throw new Error(`Invalid sender email format: ${sender}`);
  }
  if (search_text && !SAFE_SEARCH_RE.test(search_text)) {
    throw new Error("search_text contains unsupported characters");
  }
  const clampedDays = Math.max(1, Math.min(days, MAX_SEARCH_DAYS));

  if (env.MOCK_MODE) {
    return mockSearchUserMessages(upn, sender, subject, search_text, clampedDays);
  }

  const token = await getMSGraphToken();
  const encodedUpn = encodeURIComponent(upn);

  const params = new URLSearchParams();
  params.set("$select", "id,subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead");
  params.set("$top", "10");

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  // $search and $filter/$orderby are mutually exclusive on Graph /messages
  if (search_text) {
    params.set("$search", `"${search_text.replace(/"/g, '\\"')}"`);
    headers["ConsistencyLevel"] = "eventual";
    params.set("$count", "true");
  } else {
    params.set("$orderby", "receivedDateTime desc");

    const since = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000).toISOString();
    const filters: string[] = [`receivedDateTime ge ${since}`];

    if (sender) {
      filters.push(`from/emailAddress/address eq '${escapeODataString(sender)}'`);
    }
    if (subject) {
      filters.push(`contains(subject, '${escapeODataString(subject)}')`);
    }

    params.set("$filter", filters.join(" and "));
  }

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodedUpn}/messages?${params.toString()}`,
    { headers },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Message search failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    messages: data.value ?? [],
    count: (data.value ?? []).length,
    upn,
    searchCriteria: { sender, subject, search_text, days: clampedDays },
  };
}

async function report_message_as_phishing({
  upn,
  message_id,
  report_type = "phishing",
  justification,
}: ReportMessageAsPhishingInput): Promise<unknown> {
  validateUpn(upn);
  if (!message_id || !MESSAGE_ID_RE.test(message_id)) {
    throw new Error("Invalid or missing message_id");
  }

  if (env.MOCK_MODE) {
    return {
      reported: true,
      messageId: message_id,
      reportType: report_type,
      upn,
      justification,
      _mock: true,
    };
  }

  // Forward the message to a phishing intake mailbox.
  // The beta reportPhishing/reportJunk endpoints are not available in all tenants,
  // so we use the reliable Graph v1.0 forward action instead.
  const reportEmail = await getToolSecret("PHISHING_REPORT_EMAIL");
  if (!reportEmail) {
    throw new Error(
      "PHISHING_REPORT_EMAIL is not configured. Set it in Settings > Integrations (Microsoft Entra ID) or as an environment variable.",
    );
  }

  const token = await getMSGraphToken();
  const encodedUpn = encodeURIComponent(upn);
  // message_id is validated by MESSAGE_ID_RE to be URL-safe — no encoding needed
  // (encodeURIComponent would double-encode = padding and break Graph lookups)

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodedUpn}/messages/${message_id}/forward`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        toRecipients: [
          { emailAddress: { address: reportEmail } },
        ],
        comment: `Reported as ${report_type} by Neo agent. Justification: ${justification}`,
      }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Report message failed (${res.status}): ${errText}`);
  }

  return {
    reported: true,
    messageId: message_id,
    reportType: report_type,
    upn,
    justification,
    forwardedTo: reportEmail,
  };
}

// ── ThreatLocker Approval Requests ───────────────────────────

// SECURITY: Instance must be a simple subdomain label — no dots, slashes, or
// special characters that could redirect fetches to an unintended host (SSRF).
const TL_INSTANCE_RE = /^[a-z0-9]{1,32}$/;

const TL_STATUS_MAP: Record<string, number> = {
  pending: 1,
  approved: 4,
  ignored: 10,
};

async function getThreatLockerConfig(): Promise<{ apiKey: string; baseUrl: string; orgId: string }> {
  const apiKey = await getToolSecret("THREATLOCKER_API_KEY");
  const instance = await getToolSecret("THREATLOCKER_INSTANCE");
  const orgId = await getToolSecret("THREATLOCKER_ORG_ID");

  if (!apiKey || !instance || !orgId) {
    throw new Error(
      "ThreatLocker integration not configured — go to Settings > Integrations to add your API key, instance, and organization ID.",
    );
  }

  if (!TL_INSTANCE_RE.test(instance)) {
    throw new Error(
      "THREATLOCKER_INSTANCE contains invalid characters. Expected a short lowercase subdomain label (e.g., 'us' or 'g').",
    );
  }

  if (!GUID_RE.test(orgId)) {
    throw new Error(
      "THREATLOCKER_ORG_ID must be a valid GUID (format: 00000000-0000-0000-0000-000000000000).",
    );
  }

  return {
    apiKey,
    baseUrl: `https://portalapi.${instance}.threatlocker.com/portalapi`,
    orgId,
  };
}

function validateGuid(id: string, label: string): void {
  if (!GUID_RE.test(id)) {
    throw new Error(`Invalid ${label} format — expected a GUID`);
  }
}

async function list_threatlocker_approvals({
  status = "pending",
  search_text,
  page = 1,
  page_size = 25,
}: ListThreatLockerApprovalsInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockListThreatLockerApprovals(status);
  }

  const { apiKey, baseUrl, orgId } = await getThreatLockerConfig();

  const res = await fetch(`${baseUrl}/ApprovalRequest/ApprovalRequestGetByParameters`, {
    method: "POST",
    headers: {
      // ThreatLocker Portal API uses lowercase 'authorization' with bare API key
      authorization: apiKey,
      "Content-Type": "application/json",
      managedOrganizationId: orgId,
    },
    body: JSON.stringify({
      statusId: TL_STATUS_MAP[status] ?? 1,
      pageNumber: Math.max(1, page),
      pageSize: Math.max(1, Math.min(page_size, 50)),
      orderBy: "dateTime",
      isAscending: false,
      showChildOrganizations: false,
      showCurrentTierOnly: false,
      ...(search_text ? { searchText: search_text.slice(0, 200) } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ThreatLocker list approvals failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function get_threatlocker_approval({
  approval_request_id,
}: GetThreatLockerApprovalInput): Promise<unknown> {
  validateGuid(approval_request_id, "approval_request_id");

  if (env.MOCK_MODE) {
    return mockGetThreatLockerApproval(approval_request_id);
  }

  const { apiKey, baseUrl, orgId } = await getThreatLockerConfig();

  const res = await fetch(
    `${baseUrl}/ApprovalRequest/ApprovalRequestGetPermitApplicationById?approvalRequestId=${encodeURIComponent(approval_request_id)}`,
    {
      headers: {
        authorization: apiKey,
        managedOrganizationId: orgId,
      },
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ThreatLocker get approval failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function approve_threatlocker_request({
  approval_request_id,
  policy_level = "computer",
  justification,
}: ApproveThreatLockerRequestInput): Promise<unknown> {
  validateGuid(approval_request_id, "approval_request_id");

  if (env.MOCK_MODE) {
    return {
      approved: true,
      approvalRequestId: approval_request_id,
      policyLevel: policy_level,
      justification,
      _mock: true,
    };
  }

  const { apiKey, baseUrl, orgId } = await getThreatLockerConfig();

  // Fetch the full request details first (needed for the permit body)
  const details = await get_threatlocker_approval({ approval_request_id });
  const detailsObj = details as Record<string, unknown>;

  // Validate required fields from the API response before constructing the approve body
  const requestJson = detailsObj.json ?? detailsObj.approvalRequestJson;
  if (requestJson === undefined || requestJson === null) {
    throw new Error(
      `ThreatLocker approve failed — approval request ${approval_request_id} is missing the required "json" field in its details response.`,
    );
  }

  // Verify the request belongs to the configured organization
  if (
    typeof detailsObj.organizationId === "string" &&
    detailsObj.organizationId.toLowerCase() !== orgId.toLowerCase()
  ) {
    throw new Error(
      `ThreatLocker approve aborted — the approval request belongs to organization ${detailsObj.organizationId} but the configured THREATLOCKER_ORG_ID is ${orgId}.`,
    );
  }

  // Check for matching applications — the API requires one to exist.
  // If no match, the analyst must approve manually in the ThreatLocker portal.
  const matchingApps = Array.isArray(detailsObj.matchingApplications)
    ? detailsObj.matchingApplications
    : [];
  if (matchingApps.length === 0) {
    return {
      approved: false,
      approvalRequestId: approval_request_id,
      error: "No matching application found in ThreatLocker's catalog for this request. " +
        "The ThreatLocker API does not support creating new applications — this request " +
        "must be approved manually in the ThreatLocker portal where you can create a new " +
        "application and assign the policy.",
    };
  }

  const res = await fetch(`${baseUrl}/ApprovalRequest/ApprovalRequestPermitApplication`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
      managedOrganizationId: orgId,
    },
    body: JSON.stringify({
      approvalRequest: {
        approvalRequestId: approval_request_id,
        json: requestJson,
        comments: justification,
      },
      computerId: detailsObj.computerId,
      computerGroupId: detailsObj.computerGroupId,
      organizationId: detailsObj.organizationId,
      osType: detailsObj.osType ?? 1,
      matchingApplications: { useMatchingApplication: true },
      policyConditions: { ruleId: 0 },
      policyLevel: {
        toComputer: policy_level === "computer",
        toComputerGroup: policy_level === "group",
        toEntireOrganization: policy_level === "organization",
      },
      ringfenceActionId: 0,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ThreatLocker approve request failed (${res.status}): ${errText}`);
  }

  logger.info("ThreatLocker approval request approved", "threatlocker", {
    toolName: "approve_threatlocker_request",
    policyLevel: policy_level,
  });

  return {
    approved: true,
    approvalRequestId: approval_request_id,
    policyLevel: policy_level,
    justification,
  };
}

async function deny_threatlocker_request({
  approval_request_id,
  justification,
}: DenyThreatLockerRequestInput): Promise<unknown> {
  validateGuid(approval_request_id, "approval_request_id");

  if (env.MOCK_MODE) {
    return {
      denied: true,
      approvalRequestId: approval_request_id,
      justification,
      _mock: true,
    };
  }

  const { apiKey, baseUrl, orgId } = await getThreatLockerConfig();

  // Sets the request status to "ignored" (statusId 10) — effectively denying it.
  // Endpoint name is misleading ("Authorize"); confirmed via ThreatLocker Portal API docs:
  // https://threatlocker.kb.help/portalapiapprovalrequest/
  const res = await fetch(`${baseUrl}/ApprovalRequest/ApprovalRequestAuthorizeForPermitById`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
      managedOrganizationId: orgId,
    },
    body: JSON.stringify({
      approvalRequestId: approval_request_id,
      message: justification,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ThreatLocker deny request failed (${res.status}): ${errText}`);
  }

  logger.info("ThreatLocker approval request denied", "threatlocker", {
    toolName: "deny_threatlocker_request",
  });

  return {
    denied: true,
    approvalRequestId: approval_request_id,
    justification,
  };
}

// ── Defender for Endpoint Custom Indicators ──────────────────

import { isIP } from "net";

const INDICATOR_TYPE_MAP: Record<IndicatorType, string> = {
  domain: "DomainName",
  ip: "IpAddress",
  url: "Url",
  sha1: "FileSha1",
  sha256: "FileSha256",
  md5: "FileMd5",
  cert: "CertificateThumbprint",
};

const FILE_INDICATOR_TYPES = new Set(["FileSha1", "FileSha256", "FileMd5"]);

const HASH_LENGTHS: Partial<Record<IndicatorType, number>> = {
  sha1: 40, sha256: 64, md5: 32, cert: 40,
};

const SEVERITY_MAP: Record<string, string> = {
  informational: "Informational", low: "Low", medium: "Medium", high: "High",
};

const ACTION_MAP: Record<string, string> = {
  block: "Block", warn: "Warn", audit: "Audit",
};

function validateExpiration(expiration: string | undefined): void {
  if (!expiration) return;
  const exp = new Date(expiration);
  if (isNaN(exp.getTime())) {
    throw new Error("Expiration is not a valid ISO-8601 datetime");
  }
  if (exp.getTime() < Date.now()) {
    throw new Error("Expiration date is in the past");
  }
}

function validateIndicatorValue(value: string, indicatorType: IndicatorType): void {
  const expectedLen = HASH_LENGTHS[indicatorType];
  if (expectedLen) {
    if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== expectedLen) {
      throw new Error(`Invalid ${indicatorType} — expected ${expectedLen} hex characters, got ${value.length}`);
    }
    return;
  }
  if (indicatorType === "ip") {
    if (isIP(value) === 0) {
      throw new Error(`Invalid IP address: ${value}`);
    }
    return;
  }
  if (indicatorType === "url") {
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("URL must use http or https");
      }
    } catch {
      throw new Error(`Invalid URL format: ${value}`);
    }
    return;
  }
  if (indicatorType === "domain") {
    // Allow optional wildcard prefix for subdomain-blocking indicators
    const normalized = value.startsWith("*.") ? value.slice(2) : value;
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(normalized)) {
      throw new Error(`Invalid domain format: ${value}`);
    }
  }
}

function buildIndicatorBody(
  value: string,
  indicatorType: IndicatorType,
  action: string,
  title: string,
  options: {
    description?: string;
    severity?: string;
    expiration?: string;
    generateAlert?: boolean;
  },
): Record<string, unknown> {
  const defenderType = INDICATOR_TYPE_MAP[indicatorType];
  const defenderAction = ACTION_MAP[action];
  if (!defenderAction) {
    throw new Error(`Unknown indicator action: ${action}`);
  }
  const finalAction = action === "block" && FILE_INDICATOR_TYPES.has(defenderType)
    ? "BlockAndRemediate"
    : defenderAction;

  return {
    indicatorValue: value,
    indicatorType: defenderType,
    action: finalAction,
    title,
    description: options.description ?? "",
    severity: SEVERITY_MAP[options.severity ?? "high"] ?? "High",
    ...(options.expiration ? { expirationTime: options.expiration } : {}),
    rbacGroupNames: ["All Devices"],
    generateAlert: options.generateAlert ?? true,
  };
}

const DEFENDER_INDICATOR_BASE = "https://api.securitycenter.microsoft.com/api/indicators";

async function block_indicator({
  value,
  indicator_type,
  action = "block",
  title,
  description,
  severity = "high",
  expiration,
  generate_alert = true,
}: BlockIndicatorInput): Promise<unknown> {
  validateIndicatorValue(value, indicator_type);
  validateExpiration(expiration);

  if (env.MOCK_MODE) {
    const mockBody = buildIndicatorBody(value, indicator_type, action, title, {
      description, severity, expiration, generateAlert: generate_alert,
    });
    return { id: 12345, ...mockBody, _mock: true };
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const body = buildIndicatorBody(value, indicator_type, action, title, {
    description, severity, expiration, generateAlert: generate_alert,
  });

  const res = await fetch(DEFENDER_INDICATOR_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Block indicator failed (${res.status}): ${errText}`);
  }

  logger.info("Defender indicator created", "executors", { toolName: "block_indicator" });
  return await res.json();
}

async function import_indicators({
  indicators,
  description,
  expiration,
}: ImportIndicatorsInput): Promise<unknown> {
  if (!Array.isArray(indicators) || indicators.length === 0) {
    throw new Error("indicators array is required and must not be empty");
  }
  if (indicators.length > 500) {
    throw new Error(`Batch import limited to 500 indicators (got ${indicators.length})`);
  }

  validateExpiration(expiration);

  for (let i = 0; i < indicators.length; i++) {
    const ind = indicators[i];
    if (!ind.title?.trim()) {
      throw new Error(`Indicator at index ${i}: title is required`);
    }
    validateIndicatorValue(ind.value, ind.indicator_type);
  }

  if (env.MOCK_MODE) {
    return {
      importedCount: indicators.length,
      failedCount: 0,
      _mock: true,
    };
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const mapped = indicators.map((ind) =>
    buildIndicatorBody(ind.value, ind.indicator_type, ind.action ?? "block", ind.title, {
      description, severity: ind.severity ?? "high", expiration,
    }),
  );

  const res = await fetch(`${DEFENDER_INDICATOR_BASE}/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ Indicators: mapped }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Import indicators failed (${res.status}): ${errText}`);
  }

  logger.info("Defender indicators imported", "executors", {
    toolName: "import_indicators",
    count: indicators.length,
  });
  return await res.json();
}

async function list_indicators({
  indicator_type,
  top = 25,
}: ListIndicatorsInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockListIndicators(indicator_type);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const params = new URLSearchParams();
  params.set("$top", String(Math.min(top, 100)));
  if (indicator_type) {
    // SECURITY: defenderType comes from a hardcoded map, not user input
    const defenderType = INDICATOR_TYPE_MAP[indicator_type];
    if (defenderType) {
      params.set("$filter", `indicatorType eq '${defenderType}'`);
    }
  }

  const res = await fetch(`${DEFENDER_INDICATOR_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`List indicators failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return { indicators: data.value ?? [], count: (data.value ?? []).length };
}

async function delete_indicator({ indicator_id, justification }: DeleteIndicatorInput): Promise<unknown> {
  // indicator_id is typed as number; runtime guard catches non-integer values from the as-unknown cast
  if (!Number.isInteger(indicator_id) || indicator_id <= 0) {
    throw new Error("indicator_id must be a positive integer");
  }

  if (env.MOCK_MODE) {
    return { deleted: true, indicatorId: indicator_id, justification, _mock: true };
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");

  // DELETE returns 204 No Content on success; res.ok covers 200–299 including 204
  const res = await fetch(`${DEFENDER_INDICATOR_BASE}/${indicator_id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Delete indicator failed (${res.status}): ${errText}`);
  }

  logger.info("Defender indicator deleted", "executors", { toolName: "delete_indicator" });
  return { deleted: true, indicatorId: indicator_id, justification };
}

// ── Lansweeper ───────────────────────────────────────────────

const LANSWEEPER_MAX_VULN_PAGES = 20; // 2,000 vulnerabilities max

async function getLansweeperConfig(): Promise<{ apiToken: string; siteId: string }> {
  const apiToken = await getToolSecret("LANSWEEPER_API_TOKEN");
  const siteId = await getToolSecret("LANSWEEPER_SITE_ID");

  if (!apiToken || !siteId) {
    throw new Error(
      "Lansweeper integration not configured — go to Settings > Integrations to add your API token and site ID.",
    );
  }

  return { apiToken, siteId };
}

async function lansweeperGraphQL(
  config: { apiToken: string },
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch("https://api.lansweeper.com/api/v2/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error(`Lansweeper API error (${res.status}): ${errText.slice(0, 500)}`, "lansweeper");
    throw new Error(`Lansweeper API request failed (HTTP ${res.status}). Check server logs for details.`);
  }

  const json = await res.json() as { data?: unknown; errors?: { message: string }[] };

  if (json.errors && json.errors.length > 0) {
    const msgs = json.errors.map((e) => e.message).join("; ");
    logger.error(`Lansweeper GraphQL error: ${msgs}`, "lansweeper");
    throw new Error("Lansweeper GraphQL query failed. Check server logs for details.");
  }

  return json.data;
}

async function searchAsset(
  config: { apiToken: string; siteId: string },
  search: string,
  type: "name" | "ip" | "serial",
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const conditions: { operator: string; path: string; value: string }[] = [];

  if (type === "ip") {
    conditions.push({ operator: "LIKE", path: "assetBasicInfo.ipAddress", value: search });
  } else if (type === "serial") {
    conditions.push({ operator: "EQUAL", path: "assetCustom.serialNumber", value: search });
  } else {
    conditions.push(
      { operator: "EQUAL", path: "assetBasicInfo.name", value: search },
      { operator: "LIKE", path: "assetBasicInfo.ipAddress", value: search },
    );
  }

  const query = `
    query SearchAsset($siteId: ID!, $conditions: [AssetFilterConditionInput!]!) {
      site(id: $siteId) {
        assetResources(
          assetPagination: { limit: 5, page: FIRST }
          fields: [
            "assetBasicInfo.name"
            "assetBasicInfo.ipAddress"
            "assetBasicInfo.type"
            "assetBasicInfo.userName"
            "assetCustom.serialNumber"
            "url"
          ]
          filters: { conjunction: OR, conditions: $conditions }
        ) {
          total
          items
        }
      }
    }
  `;

  const data = await lansweeperGraphQL(config, query, { siteId: config.siteId, conditions }) as {
    site: { assetResources: { total: number; items: Record<string, unknown>[] } };
  };

  return data.site.assetResources;
}

async function getAssetDetails(
  config: { apiToken: string; siteId: string },
  assetKey: string,
): Promise<Record<string, unknown>> {
  const query = `
    query AssetDetails($siteId: ID!, $assetKey: String!) {
      site(id: $siteId) {
        assetDetails(key: $assetKey) {
          key
          url
          assetBasicInfo {
            name
            type
            domain
            ipAddress
            mac
            userName
            userDomain
            description
            lastSeen
            firstSeen
          }
          assetCustom {
            manufacturer
            model
            serialNumber
            stateName
            location
            department
            fields {
              name
              value
              fieldKey
            }
          }
          operatingSystem {
            caption
            version
            buildNumber
          }
          loggedOnUsers {
            userName
            fullName
            numberOfLogons
            lastLogon
          }
          userRelations {
            userKey
            relationType
          }
        }
      }
    }
  `;

  const data = await lansweeperGraphQL(config, query, { siteId: config.siteId, assetKey }) as {
    site: { assetDetails: Record<string, unknown> };
  };

  return data.site.assetDetails;
}

async function getAssetVulnerabilities(
  config: { apiToken: string; siteId: string },
  assetKey: string,
): Promise<{ total: number; items: Record<string, unknown>[]; capped: boolean }> {
  const allItems: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let total = 0;
  let pageCount = 0;
  let capped = false;

  for (;;) {
    if (++pageCount > LANSWEEPER_MAX_VULN_PAGES) {
      logger.warn(`Vulnerability pagination capped at ${LANSWEEPER_MAX_VULN_PAGES} pages for asset ${assetKey}`, "lansweeper");
      capped = true;
      break;
    }

    const query = `
      query AssetVulns($siteId: ID!, $assetKey: String!, $pagination: VulnerabilityPaginationInput!) {
        site(id: $siteId) {
          vulnerabilities(
            pagination: $pagination
            filters: {
              conjunction: AND
              conditions: [
                { operator: EQUAL, path: "assetKey", value: $assetKey }
              ]
            }
          ) {
            total
            pagination {
              next
            }
            items {
              cve
              riskScore
              severity
              baseScore
              attackVector
              attackComplexity
              publishedOn
              updatedOn
              isActive
              cause {
                category
                affectedProduct
                vendor
              }
            }
          }
        }
      }
    `;

    const pagination = cursor
      ? { limit: 100, page: "NEXT", cursor }
      : { limit: 100, page: "FIRST" };

    const data = await lansweeperGraphQL(config, query, {
      siteId: config.siteId,
      assetKey,
      pagination,
    }) as {
      site: {
        vulnerabilities: {
          total: number;
          pagination: { next: string | null };
          items: Record<string, unknown>[];
        };
      };
    };

    const vulns = data.site.vulnerabilities;
    if (typeof vulns.total !== "number") break;
    total = vulns.total;
    allItems.push(...vulns.items);

    if (!vulns.pagination.next || allItems.length >= total) break;
    cursor = vulns.pagination.next;
  }

  return { total, items: allItems, capped };
}

async function lookup_asset({ search, search_type }: LookupAssetInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockLookupAsset(search);
  }

  if (!search || search.length > 256) {
    throw new Error("search must be between 1 and 256 characters.");
  }

  const config = await getLansweeperConfig();
  const type = detectSearchType(search, search_type);
  const results = await searchAsset(config, search, type);

  if (results.total === 0) {
    return { message: `No assets found matching "${search}" (searched by ${type}).`, results: [] };
  }

  // Multiple matches — return disambiguation list
  if (results.total > 1) {
    return {
      message: `Found ${results.total} assets matching "${search}". Please specify which asset:`,
      matches: results.items,
    };
  }

  // Exactly one match — get full details
  const asset = results.items[0];
  const assetKey = (asset.key ?? asset._id) as string;
  const details = await getAssetDetails(config, assetKey);

  // Fetch vulnerabilities (graceful degradation)
  let vulnSummary: VulnSummary | string;
  try {
    const vulnData = await getAssetVulnerabilities(config, assetKey);
    const summary = buildVulnSummary(vulnData.items);
    if (vulnData.capped) {
      summary.totalCount = vulnData.total;
    }
    vulnSummary = summary;
  } catch {
    vulnSummary = "Vulnerability data unavailable (may require Lansweeper Pro/Enterprise plan or View Vulnerabilities permission).";
  }

  const assetBasicInfo = details.assetBasicInfo as Record<string, unknown> ?? {};
  const assetCustom = details.assetCustom as Record<string, unknown> ?? {};
  const os = details.operatingSystem as Record<string, unknown> ?? {};

  const tags = extractCustomTags(assetCustom.fields as { name: string; value: string }[] | undefined);
  const primaryUser = identifyPrimaryUser(
    details.loggedOnUsers as { userName: string; fullName?: string; numberOfLogons?: number; lastLogon?: string }[] | undefined,
    assetBasicInfo.userName as string | undefined,
  );

  return {
    assetIdentity: {
      name: assetBasicInfo.name,
      type: assetBasicInfo.type,
      ipAddress: assetBasicInfo.ipAddress,
      mac: assetBasicInfo.mac,
      domain: assetBasicInfo.domain,
      manufacturer: assetCustom.manufacturer,
      model: assetCustom.model,
      serialNumber: assetCustom.serialNumber,
      os: os.caption ? `${os.caption} ${os.version ?? ""} (Build ${os.buildNumber ?? "unknown"})` : null,
      lastSeen: assetBasicInfo.lastSeen,
      lansweeperUrl: details.url,
    },
    tags,
    primaryUser,
    vulnerabilities: vulnSummary,
  };
}

// ── Abnormal Security ────────────────────────────────────────

async function getAbnormalConfig(): Promise<{ apiToken: string }> {
  const apiToken = await getToolSecret("ABNORMAL_API_TOKEN");

  if (!apiToken) {
    throw new Error(
      "Abnormal Security integration not configured — go to Settings > Integrations to add your API token.",
    );
  }

  return { apiToken };
}

const ABNORMAL_BASE_URL = "https://api.abnormalsecurity.com";

async function abnormalApi(
  config: { apiToken: string },
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${ABNORMAL_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error(`Abnormal API error (${res.status}): ${errText.slice(0, 500)}`, "abnormal");
    throw new Error(`Abnormal Security API request failed (HTTP ${res.status}). Check server logs for details.`);
  }

  return await res.json();
}

async function search_abnormal_messages(input: SearchAbnormalMessagesInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockSearchAbnormalMessages();
  }

  // Validate typed filter fields
  if (input.attachment_md5_hash && !validateMd5Hash(input.attachment_md5_hash)) {
    throw new Error("Invalid attachment_md5_hash — expected a 32-character hexadecimal string.");
  }
  if (input.sender_email && !validateSenderEmail(input.sender_email)) {
    throw new Error("Invalid sender_email format.");
  }
  if (input.sender_ip && !validateSenderIp(input.sender_ip)) {
    throw new Error("Invalid sender_ip format — expected an IPv4 address.");
  }
  if (input.body_link && !validateBodyLink(input.body_link)) {
    throw new Error("Invalid body_link — must be an http or https URL.");
  }

  // Default missing time bounds independently so partial ranges are always bounded
  const fallback = defaultTimeRange();
  const pageSize = Math.max(1, Math.min(input.page_size ?? 50, 1000));

  const config = await getAbnormalConfig();
  const body: Record<string, unknown> = {
    source: input.source ?? "abnormal",
    page_size: pageSize,
    page_number: input.page_number ?? 1,
    start_time: input.start_time ?? fallback.start_time,
    end_time: input.end_time ?? fallback.end_time,
    ...(input.sender_email ? { sender_email: input.sender_email } : {}),
    ...(input.sender_name ? { sender_name: input.sender_name } : {}),
    ...(input.recipient_email ? { recipient_email: input.recipient_email } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.attachment_name ? { attachment_name: input.attachment_name } : {}),
    ...(input.attachment_md5_hash ? { attachment_md5_hash: input.attachment_md5_hash } : {}),
    ...(input.body_link ? { body_link: input.body_link } : {}),
    ...(input.sender_ip ? { sender_ip: input.sender_ip } : {}),
    ...(input.judgement ? { judgement: input.judgement } : {}),
  };

  return await abnormalApi(config, "POST", "/v1/search", body);
}

async function remediate_abnormal_messages(input: RemediateAbnormalMessagesInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockRemediateAbnormalMessages();
  }

  // search_filters is Omit<SearchAbnormalMessagesInput,...> which satisfies Record<string,unknown>
  validateRemediateInput({
    messages: input.messages,
    remediate_all: input.remediate_all,
    search_filters: input.search_filters as Record<string, unknown> | undefined,
  });

  const messageCount = input.remediate_all ? "remediate_all" : String(input.messages?.length ?? 0);
  logger.info(`Abnormal remediation: ${input.action} (${messageCount} messages, reason: ${input.remediation_reason})`, "abnormal", {
    toolName: "remediate_abnormal_messages",
    action: input.action,
    reason: input.remediation_reason,
    messageCount,
    justification: input.justification,
  });

  const config = await getAbnormalConfig();
  const body: Record<string, unknown> = {
    action: input.action,
    remediation_reason: input.remediation_reason,
  };

  if (input.remediate_all && input.search_filters) {
    body.remediate_all = true;
    body.search_filters = input.search_filters;
  } else if (input.messages) {
    body.messages = input.messages;
  }

  return await abnormalApi(config, "POST", "/v1/search/remediate", body);
}

async function get_abnormal_remediation_status({ activity_log_id }: GetAbnormalRemediationStatusInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockGetAbnormalRemediationStatus(activity_log_id);
  }

  if (!validateActivityLogId(activity_log_id)) {
    throw new Error("Invalid activity_log_id — expected a non-empty alphanumeric string (max 128 chars).");
  }

  const config = await getAbnormalConfig();
  return await abnormalApi(config, "GET", `/v1/search/activities/${encodeURIComponent(activity_log_id)}`);
}

// ── Abnormal Security: Vendor Risk Assessment ───────────────

const VENDOR_DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function validateVendorDomain(domain: string): void {
  if (!VENDOR_DOMAIN_RE.test(domain)) {
    throw new Error(`Invalid vendor domain format: ${domain}`);
  }
}

async function get_vendor_risk({ vendor_domain }: GetVendorRiskInput): Promise<unknown> {
  validateVendorDomain(vendor_domain);

  if (env.MOCK_MODE) {
    return mockGetVendorRisk(vendor_domain);
  }

  const config = await getAbnormalConfig();
  return await abnormalApi(config, "GET", `/v1/vendors/${encodeURIComponent(vendor_domain)}`);
}

async function list_vendors({ page_size = 25, page_number = 1 }: ListVendorsInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockListVendors(page_size, page_number);
  }

  const config = await getAbnormalConfig();
  const ps = Math.max(1, Math.min(page_size, 100));
  const pn = Math.max(1, page_number);
  return await abnormalApi(config, "GET", `/v1/vendors?pageSize=${ps}&pageNumber=${pn}`);
}

async function get_vendor_activity({ vendor_domain, page_size = 25, page_number = 1 }: GetVendorActivityInput): Promise<unknown> {
  validateVendorDomain(vendor_domain);

  if (env.MOCK_MODE) {
    return mockGetVendorActivity(vendor_domain, page_size, page_number);
  }

  const config = await getAbnormalConfig();
  const ps = Math.max(1, Math.min(page_size, 100));
  const pn = Math.max(1, page_number);
  return await abnormalApi(config, "GET", `/v1/vendors/${encodeURIComponent(vendor_domain)}/activity?pageSize=${ps}&pageNumber=${pn}`);
}

async function list_vendor_cases({ filter, filter_value }: ListVendorCasesInput): Promise<unknown> {
  if (filter && !filter_value) {
    throw new Error("filter_value is required when filter is provided.");
  }
  if (!filter && filter_value) {
    throw new Error("filter is required when filter_value is provided.");
  }
  if (filter_value && isNaN(new Date(filter_value).getTime())) {
    throw new Error(`filter_value must be a valid ISO-8601 datetime string, got: ${filter_value}`);
  }

  if (env.MOCK_MODE) {
    return mockListVendorCases();
  }

  const config = await getAbnormalConfig();
  let path = "/v1/vendor-cases";
  if (filter && filter_value) {
    const expression = `${filter} gte ${new Date(filter_value).toISOString()}`;
    path += `?filter=${encodeURIComponent(expression)}`;
  }
  return await abnormalApi(config, "GET", path);
}

async function get_vendor_case({ case_id }: GetVendorCaseInput): Promise<unknown> {
  if (!case_id || case_id.trim() === "") {
    throw new Error("case_id is required and must be a non-empty string");
  }

  if (env.MOCK_MODE) {
    return mockGetVendorCase(case_id);
  }

  const config = await getAbnormalConfig();
  return await abnormalApi(config, "GET", `/v1/vendor-cases/${encodeURIComponent(case_id)}`);
}

// ── Abnormal Security: Employee Risk Profile ─────────────────

// RFC 4180-compliant CSV line splitter — handles quoted fields with commas
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsvToJson(csv: string): Record<string, string>[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
    return obj;
  });
}

async function get_employee_profile({ email }: GetEmployeeProfileInput): Promise<unknown> {
  if (!validateSenderEmail(email)) {
    throw new Error(`Invalid email format: ${email}`);
  }

  if (env.MOCK_MODE) {
    return mockGetEmployeeProfile(email);
  }

  const config = await getAbnormalConfig();
  const encoded = encodeURIComponent(email);

  const [infoResult, analysisResult] = await Promise.allSettled([
    abnormalApi(config, "GET", `/v1/employee/${encoded}`),
    abnormalApi(config, "GET", `/v1/employee/${encoded}/identity-analysis`),
  ]);

  const errors: string[] = [];
  if (infoResult.status === "rejected") {
    const msg = infoResult.reason instanceof Error ? infoResult.reason.message : String(infoResult.reason);
    errors.push(`employee info: ${msg}`);
    logger.error(`Abnormal employee info failed for ${email}: ${msg}`, "abnormal");
  }
  if (analysisResult.status === "rejected") {
    const msg = analysisResult.reason instanceof Error ? analysisResult.reason.message : String(analysisResult.reason);
    errors.push(`identity analysis: ${msg}`);
    logger.error(`Abnormal identity analysis failed for ${email}: ${msg}`, "abnormal");
  }

  return {
    employee: infoResult.status === "fulfilled" ? infoResult.value : null,
    genome: analysisResult.status === "fulfilled" ? analysisResult.value : null,
    ...(errors.length > 0 && { _partial: true, _errors: errors }),
  };
}

async function get_employee_login_history({ email }: GetEmployeeLoginHistoryInput): Promise<unknown> {
  if (!validateSenderEmail(email)) {
    throw new Error(`Invalid email format: ${email}`);
  }

  if (env.MOCK_MODE) {
    return mockGetEmployeeLoginHistory(email);
  }

  const config = await getAbnormalConfig();
  const encoded = encodeURIComponent(email);

  // Login CSV returns plain text, not JSON — fetch directly instead of abnormalApi
  const res = await fetch(`${ABNORMAL_BASE_URL}/v1/employee/${encoded}/login-csv`, {
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error(`Abnormal API error (${res.status}): ${errText.slice(0, 500)}`, "abnormal");
    throw new Error(`Abnormal Security API request failed (HTTP ${res.status}). Check server logs for details.`);
  }

  const csvText = await res.text();
  const logins = parseCsvToJson(csvText);

  return { email, logins, count: logins.length };
}

// ── Abnormal Security: Threat Triage ─────────────────────────

function validateIsoDatetime(value: string, label: string): void {
  if (isNaN(new Date(value).getTime())) {
    throw new Error(`${label} must be a valid ISO-8601 datetime string, got: ${value}`);
  }
}

async function list_abnormal_threats({
  start_time,
  end_time,
  page_size = 25,
  page_number = 1,
}: ListAbnormalThreatsInput): Promise<unknown> {
  if (start_time) validateIsoDatetime(start_time, "start_time");
  if (end_time) validateIsoDatetime(end_time, "end_time");
  const ps = Math.max(1, Math.min(page_size, 100));
  const pn = Math.max(1, page_number);

  if (env.MOCK_MODE) {
    return mockListAbnormalThreats(ps, pn);
  }

  const config = await getAbnormalConfig();
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = start_time ? new Date(start_time).toISOString() : defaultStart.toISOString();
  const end = end_time ? new Date(end_time).toISOString() : now.toISOString();
  const expression = `receivedTime gte ${start} lte ${end}`;

  return await abnormalApi(
    config,
    "GET",
    `/v1/threats?filter=${encodeURIComponent(expression)}&pageSize=${ps}&pageNumber=${pn}`,
  );
}

async function get_abnormal_threat({ threat_id }: GetAbnormalThreatInput): Promise<unknown> {
  if (!threat_id || threat_id.trim() === "") {
    throw new Error("threat_id is required and must be a non-empty string");
  }

  if (env.MOCK_MODE) {
    return mockGetAbnormalThreat(threat_id);
  }

  const config = await getAbnormalConfig();
  return await abnormalApi(config, "GET", `/v1/threats/${encodeURIComponent(threat_id)}`);
}

// ── Abnormal Security: ATO Case Investigator ─────────────────

const VALID_ATO_ACTIONS = new Set(["action_required", "acknowledge"]);

async function list_ato_cases({
  filter_value,
  page_size = 25,
  page_number = 1,
}: ListAtoCasesInput): Promise<unknown> {
  if (filter_value) validateIsoDatetime(filter_value, "filter_value");
  const ps = Math.max(1, Math.min(page_size, 100));
  const pn = Math.max(1, page_number);

  if (env.MOCK_MODE) {
    return mockListAtoCases(ps, pn);
  }

  const config = await getAbnormalConfig();
  let path = `/v1/cases?pageSize=${ps}&pageNumber=${pn}`;
  if (filter_value) {
    const expression = `lastModifiedTime gte ${new Date(filter_value).toISOString()}`;
    path += `&filter=${encodeURIComponent(expression)}`;
  }

  return await abnormalApi(config, "GET", path);
}

async function get_ato_case({ case_id }: GetAtoCaseInput): Promise<unknown> {
  if (!case_id || case_id.trim() === "") {
    throw new Error("case_id is required and must be a non-empty string");
  }

  if (env.MOCK_MODE) {
    return mockGetAtoCase(case_id);
  }

  const config = await getAbnormalConfig();
  const encoded = encodeURIComponent(case_id);

  const [detailsResult, timelineResult] = await Promise.allSettled([
    abnormalApi(config, "GET", `/v1/cases/${encoded}`),
    abnormalApi(config, "GET", `/v1/cases/${encoded}/analysis-and-timeline`),
  ]);

  const errors: string[] = [];
  if (detailsResult.status === "rejected") {
    const msg = detailsResult.reason instanceof Error ? detailsResult.reason.message : String(detailsResult.reason);
    errors.push(`case details: ${msg}`);
    logger.error(`Abnormal ATO case details failed for ${case_id}: ${msg}`, "abnormal");
  }
  if (timelineResult.status === "rejected") {
    const msg = timelineResult.reason instanceof Error ? timelineResult.reason.message : String(timelineResult.reason);
    errors.push(`analysis timeline: ${msg}`);
    logger.error(`Abnormal ATO analysis timeline failed for ${case_id}: ${msg}`, "abnormal");
  }

  return {
    caseDetails: detailsResult.status === "fulfilled" ? detailsResult.value : null,
    analysisTimeline: timelineResult.status === "fulfilled" ? timelineResult.value : null,
    ...(errors.length > 0 && { _partial: true, _errors: errors }),
  };
}

async function action_ato_case({ case_id, action, justification }: ActionAtoCaseInput): Promise<unknown> {
  if (!case_id || case_id.trim() === "") {
    throw new Error("case_id is required and must be a non-empty string");
  }
  if (!VALID_ATO_ACTIONS.has(action)) {
    throw new Error(`Invalid action — must be "action_required" or "acknowledge", got: ${action}`);
  }

  if (env.MOCK_MODE) {
    const actionId = `act-mock-${Date.now()}`;
    return {
      actionId,
      caseId: case_id,
      action,
      justification,
      statusUrl: `${ABNORMAL_BASE_URL}/v1/cases/${encodeURIComponent(case_id)}/actions/${actionId}`,
      _mock: true,
    };
  }

  const config = await getAbnormalConfig();
  const result = await abnormalApi(config, "POST", `/v1/cases/${encodeURIComponent(case_id)}`, {
    action,
    ...(justification && { justification }),
  });

  logger.info("ATO case action taken", "abnormal", {
    toolName: "action_ato_case",
    action,
  });

  return result;
}

// ── Context Retrieval ─────────────────────────────────────────

// Anthropic tool_use_id format: "toolu_" followed by alphanumerics
const TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9]{10,64}$/;

function get_full_tool_result(
  { tool_use_id }: GetFullToolResultInput,
  sessionMessages?: Message[],
): unknown {
  if (!TOOL_USE_ID_RE.test(tool_use_id)) {
    return { error: "Invalid tool_use_id format." };
  }

  if (!sessionMessages) {
    return { error: "Session context not available for tool result retrieval." };
  }

  // Search backward through messages for the matching tool_result
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const msg = sessionMessages[i];
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (
        block.type === "tool_result" &&
        (block as { tool_use_id: string }).tool_use_id === tool_use_id
      ) {
        const content = (block as { content?: string | unknown[] }).content;
        return { tool_use_id, content: content ?? null };
      }
    }
  }

  return { error: `No tool result found with tool_use_id: ${tool_use_id}` };
}

// ── Router ────────────────────────────────────────────────────

const executors: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  run_sentinel_kql: (input) => run_sentinel_kql(input as unknown as SentinelKqlInput),
  get_sentinel_incidents: (input) => get_sentinel_incidents(input as unknown as SentinelIncidentsInput),
  get_xdr_alert: (input) => get_xdr_alert(input as unknown as XdrAlertInput),
  search_xdr_by_host: (input) => search_xdr_by_host(input as unknown as XdrHostSearchInput),
  get_user_info: (input) => get_user_info(input as unknown as UserInfoInput),
  reset_user_password: (input) => reset_user_password(input as unknown as ResetPasswordInput),
  dismiss_user_risk: (input) => dismiss_user_risk(input as unknown as DismissUserRiskInput),
  isolate_machine: (input) => isolate_machine(input as unknown as IsolateMachineInput),
  unisolate_machine: (input) => unisolate_machine(input as unknown as UnisolateMachineInput),
  get_machine_isolation_status: (input) => get_machine_isolation_status(input as unknown as MachineIsolationStatusInput),
  search_user_messages: (input) => search_user_messages(input as unknown as SearchUserMessagesInput),
  report_message_as_phishing: (input) => report_message_as_phishing(input as unknown as ReportMessageAsPhishingInput),
  list_threatlocker_approvals: (input) => list_threatlocker_approvals(input as unknown as ListThreatLockerApprovalsInput),
  get_threatlocker_approval: (input) => get_threatlocker_approval(input as unknown as GetThreatLockerApprovalInput),
  approve_threatlocker_request: (input) => approve_threatlocker_request(input as unknown as ApproveThreatLockerRequestInput),
  deny_threatlocker_request: (input) => deny_threatlocker_request(input as unknown as DenyThreatLockerRequestInput),
  block_indicator: (input) => block_indicator(input as unknown as BlockIndicatorInput),
  import_indicators: (input) => import_indicators(input as unknown as ImportIndicatorsInput),
  list_indicators: (input) => list_indicators(input as unknown as ListIndicatorsInput),
  delete_indicator: (input) => delete_indicator(input as unknown as DeleteIndicatorInput),
  lookup_asset: (input) => lookup_asset(input as unknown as LookupAssetInput),
  search_abnormal_messages: (input) => search_abnormal_messages(input as unknown as SearchAbnormalMessagesInput),
  remediate_abnormal_messages: (input) => remediate_abnormal_messages(input as unknown as RemediateAbnormalMessagesInput),
  get_abnormal_remediation_status: (input) => get_abnormal_remediation_status(input as unknown as GetAbnormalRemediationStatusInput),
  get_vendor_risk: (input) => get_vendor_risk(input as unknown as GetVendorRiskInput),
  list_vendors: (input) => list_vendors(input as unknown as ListVendorsInput),
  get_vendor_activity: (input) => get_vendor_activity(input as unknown as GetVendorActivityInput),
  list_vendor_cases: (input) => list_vendor_cases(input as unknown as ListVendorCasesInput),
  get_vendor_case: (input) => get_vendor_case(input as unknown as GetVendorCaseInput),
  get_employee_profile: (input) => get_employee_profile(input as unknown as GetEmployeeProfileInput),
  get_employee_login_history: (input) => get_employee_login_history(input as unknown as GetEmployeeLoginHistoryInput),
  list_abnormal_threats: (input) => list_abnormal_threats(input as unknown as ListAbnormalThreatsInput),
  get_abnormal_threat: (input) => get_abnormal_threat(input as unknown as GetAbnormalThreatInput),
  list_ato_cases: (input) => list_ato_cases(input as unknown as ListAtoCasesInput),
  get_ato_case: (input) => get_ato_case(input as unknown as GetAtoCaseInput),
  action_ato_case: (input) => action_ato_case(input as unknown as ActionAtoCaseInput),
};

export interface ExecuteToolContext {
  sessionMessages?: Message[];
}

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: ExecuteToolContext,
): Promise<unknown> {
  logger.debug(`Executing tool: ${toolName}`, "executors", { toolName });

  if (toolName === "get_full_tool_result") {
    return get_full_tool_result(toolInput as unknown as GetFullToolResultInput, context?.sessionMessages);
  }

  const fn = executors[toolName];
  if (!fn) {
    logger.error(`Unknown tool: ${toolName}`, "executors", { toolName });
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return await fn(toolInput);
}

// ─────────────────────────────────────────────────────────────
//  Mock implementations (MOCK_MODE=true only)
// ─────────────────────────────────────────────────────────────

function mockSentinelKql(query: string): unknown {
  if (query.toLowerCase().includes("signinlogs") || query.toLowerCase().includes("signin")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: [
          { name: "TimeGenerated", type: "datetime" },
          { name: "UserPrincipalName", type: "string" },
          { name: "IPAddress", type: "string" },
          { name: "Location", type: "string" },
          { name: "ResultType", type: "string" },
          { name: "ResultDescription", type: "string" },
          { name: "DeviceDetail", type: "dynamic" },
          { name: "ConditionalAccessStatus", type: "string" },
        ],
        rows: [
          ["2026-03-02T12:01:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "50074", "MFA required, user did not complete", '{"displayName":"Unknown","isCompliant":false}', "failure"],
          ["2026-03-02T12:03:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "50074", "MFA required, user did not complete", '{"displayName":"Unknown","isCompliant":false}', "failure"],
          ["2026-03-02T12:05:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "50074", "MFA required, user did not complete", '{"displayName":"Unknown","isCompliant":false}', "failure"],
          ["2026-03-02T12:31:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "0", "Successfully signed in", '{"displayName":"Unknown","isCompliant":false}', "success"],
          ["2026-03-02T12:32:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "0", "Successfully signed in", '{"displayName":"Unknown","isCompliant":false}', "success"],
        ],
      }],
      _mock: true,
    };
  }

  if (query.toLowerCase().includes("auditlogs")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: ["TimeGenerated", "OperationName", "InitiatedBy", "TargetResources", "Result"],
        rows: [
          ["2026-03-02T12:33:00Z", "Add member to role", '{"user":{"userPrincipalName":"jsmith@goodwin.com"}}', '[{"displayName":"Global Readers"}]', "success"],
          ["2026-03-02T12:34:00Z", "Update user", '{"user":{"userPrincipalName":"jsmith@goodwin.com"}}', '[{"displayName":"John Smith"}]', "success"],
        ],
      }],
      _mock: true,
    };
  }

  return {
    tables: [{ name: "PrimaryResult", columns: ["TimeGenerated", "Result"], rows: [["2026-03-02T12:00:00Z", "No results"]] }],
    _mock: true,
  };
}

function mockSentinelIncidents(): unknown {
  return {
    value: [
      {
        id: "INC-2847",
        name: "INC-2847",
        properties: {
          title: "Suspicious sign-in activity from TOR exit node",
          severity: "High",
          status: "New",
          createdTimeUtc: "2026-03-02T12:35:00Z",
          description: "Multiple failed MFA attempts followed by successful authentication from known TOR exit node IP 185.220.101.47",
          relatedEntities: [{ kind: "Account", properties: { upn: "jsmith@goodwin.com" } }],
        },
      },
      {
        id: "INC-2846",
        name: "INC-2846",
        properties: {
          title: "Impossible travel detected",
          severity: "Medium",
          status: "Active",
          createdTimeUtc: "2026-03-02T09:00:00Z",
          description: "User authenticated from Boston, then Frankfurt 20 minutes later",
          relatedEntities: [{ kind: "Account", properties: { upn: "bwilliams@goodwin.com" } }],
        },
      },
    ],
    _mock: true,
  };
}

function mockXdrAlert(alertId: string, platform: string): unknown {
  return {
    id: alertId,
    platform,
    title: "Suspicious PowerShell execution with encoded command",
    severity: "High",
    status: "New",
    machineId: "a1b2c3d4e5f6",
    computerDnsName: "LAPTOP-JS4729",
    firstEventTime: "2026-03-02T12:30:00Z",
    assignedTo: null,
    evidence: [
      {
        entityType: "Process",
        parentProcessName: "winword.exe",
        processName: "powershell.exe",
        processCommandLine: "powershell.exe -EncodedCommand JABjAD0ATgBlAHcALQBPAGIAagBlAGMAdA==",
        sha256: "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
      },
      {
        entityType: "NetworkConnection",
        remoteIpAddress: "185.220.101.47",
        remotePort: 4444,
        protocol: "TCP",
      },
    ],
    _mock: true,
  };
}

function mockXdrHostSearch(hostname: string, platform: string): unknown {
  return {
    hostname,
    platform,
    machineId: "a1b2c3d4e5f6",
    riskScore: "High",
    healthStatus: "Active",
    lastSeen: "2026-03-02T12:45:00Z",
    alerts: [
      {
        id: "ALERT-9923",
        title: "Suspicious PowerShell execution with encoded command",
        severity: "High",
        firstEventTime: "2026-03-02T12:30:00Z",
      },
    ],
    _mock: true,
  };
}

function mockUserInfo(upn: string): unknown {
  return {
    upn,
    displayName: "John Smith",
    jobTitle: "Associate Attorney",
    department: "Litigation",
    accountEnabled: true,
    lastPasswordChange: "2025-11-15T00:00:00Z",
    mfa: {
      isMfaRegistered: true,
      isMfaCapable: true,
      defaultMfaMethod: "microsoftAuthenticatorPush",
    },
    groups: ["All Staff", "Litigation", "SharePoint-Legal-RW"],
    devices: [
      { displayName: "LAPTOP-JS4729", operatingSystem: "Windows 11", isCompliant: true, lastSignIn: "2026-03-02T11:00:00Z" },
    ],
    riskState: "atRisk",
    riskLevel: "high",
    riskLastUpdated: "2026-03-02T12:35:00Z",
    _mock: true,
  };
}

function mockPasswordReset(upn: string, revokeSessions: boolean): unknown {
  const mockTempPassword = "MockTemp@1234!A";
  return {
    success: true,
    upn,
    temporaryPassword: mockTempPassword,
    sessionRevoked: revokeSessions,
    auditLogId: "AUDIT-" + Date.now(),
    completedAt: new Date().toISOString(),
    _mock: true,
  };
}

function mockIsolateMachine(hostname: string, machineId: string | undefined, platform: string, isolationType: string): unknown {
  return {
    success: true,
    hostname,
    platform,
    isolation_type: isolationType,
    machineId: machineId || "a1b2c3d4e5f6",
    actionId: "ACTION-" + Date.now(),
    status: "Pending",
    completedAt: new Date().toISOString(),
    _mock: true,
  };
}

function mockUnisolateMachine(hostname: string, platform: string): unknown {
  return {
    success: true,
    hostname,
    platform,
    actionId: "ACTION-" + Date.now(),
    status: "Pending",
    _mock: true,
  };
}

function mockMachineIsolationStatus(hostname: string, machineId: string | undefined): unknown {
  const result = buildIsolationResult(
    hostname,
    machineId || "a".repeat(40),
    [
      {
        type: "Isolate",
        status: "Succeeded",
        requestor: "analyst@goodwin.com",
        creationDateTimeUtc: "2026-03-19T14:30:00Z",
        lastUpdateDateTimeUtc: "2026-03-19T14:31:00Z",
        requestorComment: "Suspicious lateral movement detected — isolating for investigation",
      },
    ],
    {
      healthStatus: "Active",
      riskScore: "Medium",
      exposureLevel: "Medium",
      osPlatform: "Windows11",
      osVersion: "22H2",
      lastSeen: "2026-03-20T10:00:00Z",
      lastIpAddress: "10.1.50.42",
    },
  ) as Record<string, unknown>;
  return { ...result, _mock: true };
}

function mockSearchUserMessages(
  upn: string,
  sender?: string,
  subject?: string,
  search_text?: string,
  days: number = 7,
): unknown {
  return {
    messages: [
      {
        id: "AAMkAGI2TG93AAA=",
        subject: subject || "Urgent: Invoice #4829 - Payment Required",
        from: {
          emailAddress: {
            name: sender || "accounts@suspicious-domain.com",
            address: sender || "accounts@suspicious-domain.com",
          },
        },
        receivedDateTime: "2026-03-19T09:15:00Z",
        bodyPreview: "Dear user, please review the attached invoice and process payment immediately. Click here to view...",
        hasAttachments: true,
        isRead: true,
      },
      {
        id: "AAMkAGI2TG94AAA=",
        subject: "Re: Quarterly Report",
        from: {
          emailAddress: {
            name: "jdoe@goodwin.com",
            address: "jdoe@goodwin.com",
          },
        },
        receivedDateTime: "2026-03-19T08:30:00Z",
        bodyPreview: "Thanks for sending this over. I've reviewed the numbers and everything looks good...",
        hasAttachments: false,
        isRead: true,
      },
      {
        id: "AAMkAGI2TG95AAA=",
        subject: "Action Required: Verify your account",
        from: {
          emailAddress: {
            name: "security@microsoft-verify.net",
            address: "noreply@microsoft-verify.net",
          },
        },
        receivedDateTime: "2026-03-18T14:22:00Z",
        bodyPreview: "Your Microsoft 365 account requires immediate verification. Click the link below to avoid suspension...",
        hasAttachments: false,
        isRead: false,
      },
    ],
    count: 3,
    upn,
    searchCriteria: { sender, subject, search_text, days },
    _mock: true,
  };
}

function mockListThreatLockerApprovals(status: string): unknown {
  return {
    approvalRequests: [
      {
        approvalRequestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        computerName: "DESKTOP-JS4729",
        userName: "jsmith",
        path: "C:\\Users\\jsmith\\Downloads\\installer.exe",
        hash: "TL:abc123def456",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        dateTime: "2026-03-20T14:30:00Z",
        statusId: TL_STATUS_MAP[status] ?? 1,
        actionType: "Execute",
        organizationId: "org-guid-placeholder",
      },
      {
        approvalRequestId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
        computerName: "LAPTOP-MK8812",
        userName: "mkim",
        path: "C:\\Program Files\\CustomApp\\update.exe",
        hash: "TL:789xyz012345",
        sha256: "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
        dateTime: "2026-03-20T13:15:00Z",
        statusId: TL_STATUS_MAP[status] ?? 1,
        actionType: "Execute",
        organizationId: "org-guid-placeholder",
      },
      {
        approvalRequestId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
        computerName: "WORKSTATION-04",
        userName: "admin.local",
        path: "C:\\Temp\\script.ps1",
        hash: "TL:elevate456789",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9820",
        dateTime: "2026-03-20T11:45:00Z",
        statusId: TL_STATUS_MAP[status] ?? 1,
        actionType: "Elevate",
        organizationId: "org-guid-placeholder",
      },
    ],
    totalCount: 3,
    status,
    _mock: true,
  };
}

function mockGetThreatLockerApproval(approvalRequestId: string): unknown {
  return {
    approvalRequestId,
    computerName: "DESKTOP-JS4729",
    computerId: "comp-guid-placeholder",
    computerGroupId: "group-guid-placeholder",
    userName: "jsmith",
    organizationId: "org-guid-placeholder",
    path: "C:\\Users\\jsmith\\Downloads\\installer.exe",
    hash: "TL:abc123def456",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    dateTime: "2026-03-20T14:30:00Z",
    statusId: 1,
    actionType: "Execute",
    osType: 1,
    threatLockerActionDto: {
      fullPath: "C:\\Users\\jsmith\\Downloads\\installer.exe",
      processName: "installer.exe",
      osType: 1,
      certs: [],
    },
    matchingApplications: [
      { applicationName: "Custom Application", applicationId: "app-guid-placeholder" },
    ],
    _mock: true,
  };
}

function mockListIndicators(indicatorType?: IndicatorType): unknown {
  const all = [
    {
      id: 1001,
      indicatorValue: "evil.example.com",
      indicatorType: "DomainName",
      action: "Block",
      title: "IR-2024-001 C2 Domain",
      severity: "High",
      creationTimeDateTimeUtc: "2026-03-20T10:00:00Z",
      expirationTime: "2026-06-20T00:00:00Z",
    },
    {
      id: 1002,
      indicatorValue: "185.220.101.42",
      indicatorType: "IpAddress",
      action: "Block",
      title: "TOR exit node — lateral movement source",
      severity: "High",
      creationTimeDateTimeUtc: "2026-03-19T14:30:00Z",
      expirationTime: null,
    },
    {
      id: 1003,
      indicatorValue: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      indicatorType: "FileSha256",
      action: "BlockAndRemediate",
      title: "Malware payload — phishing campaign March 2026",
      severity: "High",
      creationTimeDateTimeUtc: "2026-03-18T09:15:00Z",
      expirationTime: "2026-04-18T00:00:00Z",
    },
  ];

  const filtered = indicatorType
    ? all.filter((i) => i.indicatorType === INDICATOR_TYPE_MAP[indicatorType])
    : all;

  return { indicators: filtered, count: filtered.length, _mock: true };
}

function mockLookupAsset(search: string): unknown {
  return {
    assetIdentity: {
      name: search || "YOURPC01",
      type: "Windows",
      ipAddress: "10.0.1.42",
      mac: "AA:BB:CC:DD:EE:FF",
      domain: "goodwin.local",
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
      topCves: [
        {
          cve: "CVE-2026-21001",
          riskScore: 9.8,
          severity: "Critical",
          baseScore: 9.8,
          attackVector: "NETWORK",
          attackComplexity: "LOW",
          isActive: true,
          cause: { category: "OS", affectedProduct: "Windows 11", vendor: "Microsoft" },
        },
        {
          cve: "CVE-2026-18742",
          riskScore: 8.1,
          severity: "High",
          baseScore: 8.1,
          attackVector: "NETWORK",
          attackComplexity: "HIGH",
          isActive: true,
          cause: { category: "Application", affectedProduct: "Chrome", vendor: "Google" },
        },
        {
          cve: "CVE-2026-14023",
          riskScore: 6.5,
          severity: "Medium",
          baseScore: 6.5,
          attackVector: "LOCAL",
          attackComplexity: "LOW",
          isActive: true,
          cause: { category: "Driver", affectedProduct: "Intel Graphics Driver", vendor: "Intel" },
        },
      ],
    },
    _mock: true,
  };
}

function mockSearchAbnormalMessages(): unknown {
  return {
    total_count: 3,
    page_number: 1,
    messages: [
      {
        message_id: "msg-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        subject: "Urgent: Verify your account credentials",
        sender_email: "security-alert@evil-domain.com",
        sender_name: "IT Security Team",
        recipient_email: "jsmith@goodwin.com",
        received_time: "2026-03-24T14:30:00Z",
        judgement: "attack",
        attack_type: "Credential Phishing",
        has_attachments: false,
      },
      {
        message_id: "msg-b2c3d4e5-f6a7-8901-bcde-f12345678901",
        subject: "Urgent: Verify your account credentials",
        sender_email: "security-alert@evil-domain.com",
        sender_name: "IT Security Team",
        recipient_email: "bwilliams@goodwin.com",
        received_time: "2026-03-24T14:31:00Z",
        judgement: "attack",
        attack_type: "Credential Phishing",
        has_attachments: false,
      },
      {
        message_id: "msg-c3d4e5f6-a7b8-9012-cdef-123456789012",
        subject: "Invoice #INV-2026-3847 — Payment Required",
        sender_email: "billing@spoofed-vendor.com",
        sender_name: "Accounts Payable",
        recipient_email: "finance-team@goodwin.com",
        received_time: "2026-03-24T15:10:00Z",
        judgement: "attack",
        attack_type: "Invoice/Payment Fraud",
        has_attachments: true,
      },
    ],
    _mock: true,
  };
}

function mockRemediateAbnormalMessages(): unknown {
  return {
    activity_log_id: "act-d4e5f6a7-b8c9-0123-def4-567890abcdef",
    status: "pending",
    message: "Remediation submitted successfully.",
    _mock: true,
  };
}

function mockGetAbnormalRemediationStatus(activityLogId: string): unknown {
  return {
    activity_log_id: activityLogId || "act-d4e5f6a7-b8c9-0123-def4-567890abcdef",
    status: "completed",
    action: "delete",
    message_count: 3,
    completed_at: "2026-03-24T15:45:00Z",
    _mock: true,
  };
}

function mockGetVendorRisk(domain: string): unknown {
  return {
    vendorDomain: domain,
    riskLevel: "High",
    vendorContacts: [
      { email: "billing@" + domain, name: "Billing Department" },
      { email: "support@" + domain, name: "Support Team" },
    ],
    companyContacts: [
      { email: "jsmith@goodwin.com", name: "John Smith" },
      { email: "mkim@goodwin.com", name: "Maria Kim" },
    ],
    vendorCountries: ["US", "DE"],
    vendorIpAddresses: ["203.0.113.42", "198.51.100.10"],
    analysis: [
      "Vendor Compromise Seen in Abnormal Community",
      "Suspicious mail-server configuration change detected",
    ],
    _mock: true,
  };
}

function mockListVendors(pageSize: number = 25, pageNumber: number = 1): unknown {
  return {
    vendors: [
      { vendorDomain: "acme-billing.com", riskLevel: "High" },
      { vendorDomain: "legal-services.net", riskLevel: "Medium" },
      { vendorDomain: "trusted-partner.com", riskLevel: "Low" },
    ],
    totalCount: 3,
    pageSize,
    pageNumber,
    _mock: true,
  };
}

function mockGetVendorActivity(domain: string, pageSize: number = 25, pageNumber: number = 1): unknown {
  return {
    vendorDomain: domain,
    events: [
      {
        eventTimestamp: "2026-03-20T14:30:00Z",
        eventType: "SuspiciousEmail",
        suspiciousDomain: "acme-bi11ing.com",
        domainIp: "185.220.101.42",
        attackGoal: "Invoice Fraud",
        actionTaken: "Blocked",
        hasEngagement: false,
        recipient: "jsmith@goodwin.com",
        threatId: "threat-abc123",
      },
      {
        eventTimestamp: "2026-03-19T09:15:00Z",
        eventType: "DomainSpoof",
        suspiciousDomain: "acme-billing.co",
        domainIp: "192.0.2.99",
        attackGoal: "Credential Harvest",
        actionTaken: "Warned",
        hasEngagement: true,
        recipient: "mkim@goodwin.com",
        threatId: "threat-def456",
      },
    ],
    pageSize,
    pageNumber,
    _mock: true,
  };
}

function mockListVendorCases(): unknown {
  return {
    vendorCases: [
      {
        caseId: "vc-001",
        vendorDomain: "acme-billing.com",
        firstObservedTime: "2026-03-18T00:00:00Z",
        lastModifiedTime: "2026-03-20T14:30:00Z",
        status: "Active",
      },
      {
        caseId: "vc-002",
        vendorDomain: "legal-services.net",
        firstObservedTime: "2026-03-15T00:00:00Z",
        lastModifiedTime: "2026-03-19T09:00:00Z",
        status: "Resolved",
      },
    ],
    totalCount: 2,
    _mock: true,
  };
}

function mockGetVendorCase(caseId: string): unknown {
  return {
    caseId,
    vendorDomain: "acme-billing.com",
    status: "Active",
    insights: [
      "Look-alike domain detected: acme-bi11ing.com (uses digit '1' instead of 'l')",
      "Young sender domain: registered 14 days ago",
      "Inconsistent registrar: domain transferred from GoDaddy to obscure registrar",
    ],
    timeline: [
      {
        timestamp: "2026-03-20T14:30:00Z",
        sender: "invoice@acme-bi11ing.com",
        recipient: "jsmith@goodwin.com",
        subject: "Updated Wire Instructions - Invoice #4829",
        judgement: "Malicious",
        threatId: "threat-abc123",
      },
      {
        timestamp: "2026-03-19T09:15:00Z",
        sender: "support@acme-billing.co",
        recipient: "mkim@goodwin.com",
        subject: "Action Required: Verify Payment Details",
        judgement: "Suspicious",
        threatId: "threat-def456",
      },
    ],
    _mock: true,
  };
}

function mockGetEmployeeProfile(email: string): unknown {
  return {
    employee: {
      name: "John Smith",
      email,
      title: "Associate Attorney",
      manager: "Sarah Johnson",
    },
    genome: {
      histograms: [
        {
          key: "ip_address",
          name: "Login IP Addresses",
          description: "Most common IP addresses used for sign-in",
          values: [
            { text: "198.51.100.10", ratio: 0.65, raw_count: 142 },
            { text: "203.0.113.42", ratio: 0.25, raw_count: 55 },
            { text: "10.1.50.100", ratio: 0.10, raw_count: 22 },
          ],
        },
        {
          key: "sign_in_location",
          name: "Sign-in Locations",
          description: "Geographic locations of sign-in events",
          values: [
            { text: "Boston, MA, US", ratio: 0.80, raw_count: 175 },
            { text: "New York, NY, US", ratio: 0.15, raw_count: 33 },
            { text: "Remote VPN", ratio: 0.05, raw_count: 11 },
          ],
        },
        {
          key: "device",
          name: "Devices",
          description: "Devices used for sign-in",
          values: [
            { text: "DESKTOP-JS4729", ratio: 0.70, raw_count: 153 },
            { text: "iPhone 15 Pro", ratio: 0.30, raw_count: 66 },
          ],
        },
        {
          key: "browser",
          name: "Browsers",
          description: "Browsers used for sign-in",
          values: [
            { text: "Microsoft Edge 122", ratio: 0.60, raw_count: 131 },
            { text: "Outlook Mobile", ratio: 0.30, raw_count: 66 },
            { text: "Chrome 123", ratio: 0.10, raw_count: 22 },
          ],
        },
      ],
    },
    _mock: true,
  };
}

function mockGetEmployeeLoginHistory(email: string): unknown {
  return {
    email,
    logins: [
      { timestamp: "2026-03-24T09:15:00Z", ip: "198.51.100.10", location: "Boston, MA, US", device: "DESKTOP-JS4729", browser: "Edge 122" },
      { timestamp: "2026-03-24T08:30:00Z", ip: "198.51.100.10", location: "Boston, MA, US", device: "iPhone 15 Pro", browser: "Outlook Mobile" },
      { timestamp: "2026-03-23T17:45:00Z", ip: "203.0.113.42", location: "New York, NY, US", device: "DESKTOP-JS4729", browser: "Chrome 123" },
    ],
    count: 3,
    _mock: true,
  };
}

function mockListAbnormalThreats(pageSize: number = 25, pageNumber: number = 1): unknown {
  return {
    threats: [
      {
        threatId: "threat-abc123",
        attackType: "BEC",
        attackStrategy: "Invoice Fraud",
        fromAddress: "cfo@acme-bi11ing.com",
        recipientAddress: "jsmith@goodwin.com",
        receivedTime: "2026-03-26T09:30:00Z",
        autoRemediated: false,
        remediationStatus: "Not Remediated",
      },
      {
        threatId: "threat-def456",
        attackType: "Phishing",
        attackStrategy: "Credential Harvest",
        fromAddress: "security@microsoft-verify.net",
        recipientAddress: "mkim@goodwin.com",
        receivedTime: "2026-03-26T08:15:00Z",
        autoRemediated: true,
        remediationStatus: "Auto-Remediated",
      },
      {
        threatId: "threat-ghi789",
        attackType: "Malware",
        attackStrategy: "Payload Delivery",
        fromAddress: "invoice@suspicious-sender.com",
        recipientAddress: "lchen@goodwin.com",
        receivedTime: "2026-03-25T22:45:00Z",
        autoRemediated: false,
        remediationStatus: "Not Remediated",
      },
    ],
    totalCount: 3,
    pageSize,
    pageNumber,
    _mock: true,
  };
}

function mockGetAbnormalThreat(threatId: string): unknown {
  return {
    threatId,
    attackType: "BEC",
    attackStrategy: "Invoice Fraud",
    attackVector: "Text",
    summaryInsights: [
      "Unusual Sender",
      "Never-before-seen sender domain",
      "Invoice/Payment Request Language",
      "Urgency Indicators",
    ],
    fromAddress: "cfo@acme-bi11ing.com",
    fromName: "Michael Johnson, CFO",
    senderIpAddress: "185.220.101.42",
    senderDomain: "acme-bi11ing.com",
    recipientAddress: "jsmith@goodwin.com",
    toAddresses: ["jsmith@goodwin.com"],
    subject: "URGENT: Updated Wire Instructions - Invoice #4829",
    receivedTime: "2026-03-26T09:30:00Z",
    attachmentNames: ["Invoice_4829_Updated.pdf"],
    urls: ["https://acme-bi11ing.com/wire-update"],
    urlCount: 1,
    autoRemediated: false,
    postRemediated: false,
    remediationStatus: "Not Remediated",
    impersonatedParty: "External — Acme Billing CFO",
    attackedParty: "Employee — John Smith",
    abxPortalUrl: "https://portal.abnormalsecurity.com/threats/threat-abc123",
    _mock: true,
  };
}

function mockListAtoCases(pageSize: number = 25, pageNumber: number = 1): unknown {
  return {
    cases: [
      {
        caseId: "ato-001",
        severity: "Potential Account Takeover",
        affectedEmployee: "jsmith@goodwin.com",
        case_status: "Open",
        remediation_status: "Action Required",
        firstObserved: "2026-03-25T08:00:00Z",
        lastModified: "2026-03-26T10:30:00Z",
      },
      {
        caseId: "ato-002",
        severity: "Account Takeover Confirmed",
        affectedEmployee: "mkim@goodwin.com",
        case_status: "Open",
        remediation_status: "In Progress",
        firstObserved: "2026-03-24T14:00:00Z",
        lastModified: "2026-03-26T09:15:00Z",
      },
      {
        caseId: "ato-003",
        severity: "Potential Account Takeover",
        affectedEmployee: "lchen@goodwin.com",
        case_status: "Acknowledged",
        remediation_status: "Resolved",
        firstObserved: "2026-03-22T11:00:00Z",
        lastModified: "2026-03-25T16:00:00Z",
      },
    ],
    totalCount: 3,
    pageSize,
    pageNumber,
    _mock: true,
  };
}

function mockGetAtoCase(caseId: string): unknown {
  return {
    caseDetails: {
      caseId,
      severity: "Account Takeover Confirmed",
      affectedEmployee: "jsmith@goodwin.com",
      case_status: "Open",
      remediation_status: "Action Required",
      firstObserved: "2026-03-25T08:00:00Z",
      threatIds: ["threat-abc123", "threat-def456"],
      genai_summary: "Account for jsmith@goodwin.com shows strong indicators of compromise. " +
        "Impossible travel detected between Boston and Lagos within 2 hours. " +
        "A mail forwarding rule was created to auto-delete incoming messages matching 'password reset'. " +
        "Lateral phishing emails were sent to 3 internal contacts requesting wire transfer updates.",
    },
    analysisTimeline: {
      insights: [
        { signal: "Impossible Travel", description: "Sign-in from Lagos, Nigeria — 5,300 miles from previous sign-in in Boston 2 hours earlier" },
        { signal: "Risky Location", description: "Sign-in from IP associated with known proxy service in Nigeria" },
        { signal: "Suspicious Mail Rule", description: "Mail rule created to DELETE all messages containing 'password reset' or 'security alert'" },
        { signal: "Lateral Phishing", description: "3 emails sent to internal contacts with wire transfer modification requests" },
      ],
      events: [
        {
          category: "Risk Event",
          timestamp: "2026-03-25T08:15:00Z",
          type: "Impossible Travel",
          ip: "41.58.172.33",
          geo: "Lagos, Nigeria",
          prev_location: "Boston, MA, US",
        },
        {
          category: "Sign In",
          timestamp: "2026-03-25T08:14:00Z",
          type: "Suspicious Sign-In",
          ip: "41.58.172.33",
          field_labels: ["Rare IP", "Proxy Detected", "Non-Standard User Agent"],
        },
        {
          category: "Mail Rule",
          timestamp: "2026-03-25T08:30:00Z",
          type: "Mail Rule Created",
          conditions: "Subject contains 'password reset' OR 'security alert'",
          action: "DELETE_ALL",
          detectors: ["Auto-Delete Rule", "Security Keyword Suppression"],
        },
        {
          category: "Mail Sent",
          timestamp: "2026-03-25T09:00:00Z",
          type: "Lateral Phishing",
          recipients: ["mkim@goodwin.com", "lchen@goodwin.com", "sjohnson@goodwin.com"],
          subject: "URGENT: Updated Wire Instructions - Client Matter 2024-0891",
        },
      ],
    },
    _mock: true,
  };
}
