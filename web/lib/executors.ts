import { env } from "./config";
import { getAzureToken, getMSGraphToken, generateSecurePassword } from "./auth";
import type {
  SentinelKqlInput,
  SentinelIncidentsInput,
  XdrAlertInput,
  XdrHostSearchInput,
  UserInfoInput,
  ResetPasswordInput,
  IsolateMachineInput,
  UnisolateMachineInput,
} from "./types";

// ── Input Validation Helpers ──────────────────────────────────

const VALID_SEVERITY = new Set(["High", "Medium", "Low", "Informational"]);
const VALID_STATUS = new Set(["New", "Active", "Closed"]);
const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;
const UPN_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

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

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

// ── Sentinel ──────────────────────────────────────────────────

async function run_sentinel_kql({ query, timespan = "PT24H" }: SentinelKqlInput): Promise<unknown> {
  if (env.MOCK_MODE) {
    return mockSentinelKql(query);
  }

  const token = await getAzureToken("https://api.loganalytics.io");
  const res = await fetch(
    `https://api.loganalytics.io/v1/workspaces/${env.SENTINEL_WORKSPACE_ID}/query`,
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
  const url = `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.SENTINEL_RG}/providers/Microsoft.OperationalInsights/workspaces/${env.SENTINEL_WORKSPACE_NAME}/providers/Microsoft.SecurityInsights/incidents?api-version=2023-11-01&${params}`;
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

// ── Router ────────────────────────────────────────────────────

const executors: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  run_sentinel_kql: (input) => run_sentinel_kql(input as unknown as SentinelKqlInput),
  get_sentinel_incidents: (input) => get_sentinel_incidents(input as unknown as SentinelIncidentsInput),
  get_xdr_alert: (input) => get_xdr_alert(input as unknown as XdrAlertInput),
  search_xdr_by_host: (input) => search_xdr_by_host(input as unknown as XdrHostSearchInput),
  get_user_info: (input) => get_user_info(input as unknown as UserInfoInput),
  reset_user_password: (input) => reset_user_password(input as unknown as ResetPasswordInput),
  isolate_machine: (input) => isolate_machine(input as unknown as IsolateMachineInput),
  unisolate_machine: (input) => unisolate_machine(input as unknown as UnisolateMachineInput),
};

export async function executeTool(toolName: string, toolInput: Record<string, unknown>): Promise<unknown> {
  const fn = executors[toolName];
  if (!fn) throw new Error(`Unknown tool: ${toolName}`);
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
