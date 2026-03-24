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
  GetFullToolResultInput,
  Message,
} from "./types";

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

  const token = await getMSGraphToken();
  const encodedUpn = encodeURIComponent(upn);
  // message_id is validated by MESSAGE_ID_RE to be URL-safe — no encoding needed
  // (encodeURIComponent would double-encode = padding and break Graph lookups)

  // SECURITY: Both actions use /beta endpoints — no GA SLA. Track graduation:
  // https://learn.microsoft.com/en-us/graph/api/message-reportphishing
  // https://learn.microsoft.com/en-us/graph/api/message-reportjunk
  const url = report_type === "phishing"
    ? `https://graph.microsoft.com/beta/users/${encodedUpn}/messages/${message_id}/microsoft.graph.reportPhishing`
    : `https://graph.microsoft.com/beta/users/${encodedUpn}/messages/${message_id}/microsoft.graph.reportJunk`;

  // Graph beta report actions require a JSON body (empty object is valid)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

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
