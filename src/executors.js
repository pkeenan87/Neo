// ─────────────────────────────────────────────────────────────
//  Tool Executors
//  Each function here maps to a tool name.
//  
//  MOCK_MODE=true  → returns realistic fake data (for testing the agentic loop)
//  MOCK_MODE=false → calls real Azure / Defender / Graph APIs
// ─────────────────────────────────────────────────────────────

import { env } from "./config.js";
import { getAzureToken, getMSGraphToken, generateSecurePassword } from "./auth.js";

// ── Sentinel ──────────────────────────────────────────────────

export async function run_sentinel_kql({ query, timespan = "PT24H", description }) {
  console.error(`  [TOOL] Sentinel KQL | ${description}`);
  console.error(`  [TOOL] Query: ${query.substring(0, 80)}...`);

  if (env.MOCK_MODE) {
    return mockSentinelKql(query);
  }

  const token = await getAzureToken("https://management.azure.com");
  const res = await fetch(
    `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.SENTINEL_RG}/providers/Microsoft.OperationalInsights/workspaces/${env.SENTINEL_WORKSPACE_NAME}/api/query?api-version=2020-08-01`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, timespan })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sentinel KQL query failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

export async function get_sentinel_incidents({ severity, status = "New", limit = 10 }) {
  console.error(`  [TOOL] Sentinel incidents | severity=${severity || "all"} status=${status}`);

  if (env.MOCK_MODE) {
    return mockSentinelIncidents();
  }

  const token = await getAzureToken("https://management.azure.com");
  const params = new URLSearchParams({ "$top": limit });
  if (severity) params.set("$filter", `properties/severity eq '${severity}' and properties/status eq '${status}'`);
  const url = `https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.SENTINEL_RG}/providers/Microsoft.OperationalInsights/workspaces/${env.SENTINEL_WORKSPACE_NAME}/providers/Microsoft.SecurityInsights/incidents?api-version=2023-11-01&${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sentinel incidents query failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

// ── XDR ───────────────────────────────────────────────────────

export async function get_xdr_alert({ alert_id, platform }) {
  console.error(`  [TOOL] XDR alert | platform=${platform} id=${alert_id}`);

  if (env.MOCK_MODE) {
    return mockXdrAlert(alert_id, platform);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const res = await fetch(`https://api.securitycenter.microsoft.com/api/alerts/${alert_id}`,
    { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`XDR alert lookup failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

export async function search_xdr_by_host({ hostname, platform, hours = 48 }) {
  console.error(`  [TOOL] XDR host search | platform=${platform} host=${hostname} hours=${hours}`);

  if (env.MOCK_MODE) {
    return mockXdrHostSearch(hostname, platform);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");
  const res = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${hostname}'`,
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

export async function get_user_info({ upn }) {
  console.error(`  [TOOL] Entra ID user lookup | upn=${upn}`);

  if (env.MOCK_MODE) {
    return mockUserInfo(upn);
  }

  const token = await getMSGraphToken();
  const headers = { Authorization: `Bearer ${token}` };

  const [user, mfa, groups, devices, riskDetections] = await Promise.allSettled([
    fetch(`https://graph.microsoft.com/v1.0/users/${upn}?$select=displayName,jobTitle,department,accountEnabled,lastPasswordChangeDateTime,userPrincipalName`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails/${upn}`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/v1.0/users/${upn}/memberOf`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/v1.0/users/${upn}/registeredDevices`, { headers }).then(r => r.json()),
    fetch(`https://graph.microsoft.com/beta/identityProtection/riskDetections?$filter=userPrincipalName eq '${upn}'`, { headers }).then(r => r.json())
  ]);

  return {
    user: user.status === "fulfilled" ? user.value : { error: user.reason?.message },
    mfa: mfa.status === "fulfilled" ? mfa.value : { error: mfa.reason?.message },
    groups: groups.status === "fulfilled" ? groups.value : { error: groups.reason?.message },
    devices: devices.status === "fulfilled" ? devices.value : { error: devices.reason?.message },
    riskDetections: riskDetections.status === "fulfilled" ? riskDetections.value : { error: riskDetections.reason?.message }
  };
}

// ── Destructive Actions ───────────────────────────────────────

export async function reset_user_password({ upn, revoke_sessions = true, justification }) {
  console.error(`  [TOOL] ⚠️  PASSWORD RESET | upn=${upn} revoke_sessions=${revoke_sessions}`);
  console.error(`  [TOOL] Justification: ${justification}`);

  if (env.MOCK_MODE) {
    return mockPasswordReset(upn, revoke_sessions);
  }

  const token = await getMSGraphToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const newPassword = generateSecurePassword();

  const resetRes = await fetch(`https://graph.microsoft.com/v1.0/users/${upn}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      passwordProfile: {
        password: newPassword,
        forceChangePasswordNextSignIn: true
      }
    })
  });

  if (!resetRes.ok) {
    const errText = await resetRes.text();
    throw new Error(`Password reset failed for ${upn} (${resetRes.status}): ${errText}`);
  }

  let sessionRevoked = false;
  if (revoke_sessions) {
    const revokeRes = await fetch(`https://graph.microsoft.com/v1.0/users/${upn}/revokeSignInSessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!revokeRes.ok) {
      console.error(`  [WARN] Session revocation failed for ${upn}: ${revokeRes.status}`);
    } else {
      sessionRevoked = true;
    }
  }

  return {
    success: true,
    upn,
    temporaryPassword: newPassword,
    sessionRevoked,
    completedAt: new Date().toISOString()
  };
}

export async function isolate_machine({ hostname, machine_id, platform, isolation_type = "Full", justification }) {
  console.error(`  [TOOL] ⚠️  MACHINE ISOLATION | host=${hostname} platform=${platform} type=${isolation_type}`);
  console.error(`  [TOOL] Justification: ${justification}`);

  if (env.MOCK_MODE) {
    return mockIsolateMachine(hostname, machine_id, platform, isolation_type);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");

  if (!machine_id) {
    const machineRes = await fetch(
      `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${hostname}'`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const machines = await machineRes.json();
    machine_id = machines.value?.[0]?.id;

    if (!machine_id) {
      throw new Error(`No machine found matching hostname '${hostname}' in Defender`);
    }
  }

  const res = await fetch(`https://api.securitycenter.microsoft.com/api/machines/${machine_id}/isolate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ Comment: justification, IsolationType: isolation_type })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Machine isolation failed for ${hostname} (${res.status}): ${errText}`);
  }

  return await res.json();
}

export async function unisolate_machine({ hostname, platform, justification }) {
  console.error(`  [TOOL] ⚠️  MACHINE UNISOLATE | host=${hostname} platform=${platform}`);

  if (env.MOCK_MODE) {
    return mockUnisolateMachine(hostname, platform);
  }

  const token = await getAzureToken("https://api.securitycenter.microsoft.com");

  const machineRes = await fetch(
    `https://api.securitycenter.microsoft.com/api/machines?$filter=computerDnsName eq '${hostname}'`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const machines = await machineRes.json();
  const machine_id = machines.value?.[0]?.id;

  if (!machine_id) {
    throw new Error(`No machine found matching hostname '${hostname}' in Defender`);
  }

  const res = await fetch(`https://api.securitycenter.microsoft.com/api/machines/${machine_id}/unisolate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ Comment: justification })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Machine unisolation failed for ${hostname} (${res.status}): ${errText}`);
  }

  return await res.json();
}

// ── Router ────────────────────────────────────────────────────

const executors = {
  run_sentinel_kql,
  get_sentinel_incidents,
  get_xdr_alert,
  search_xdr_by_host,
  get_user_info,
  reset_user_password,
  isolate_machine,
  unisolate_machine
};

export async function executeTool(toolName, toolInput) {
  const fn = executors[toolName];
  if (!fn) throw new Error(`Unknown tool: ${toolName}`);
  return await fn(toolInput);
}

// ─────────────────────────────────────────────────────────────
//  Mock implementations (MOCK_MODE=true only)
// ─────────────────────────────────────────────────────────────

function mockSentinelKql(query) {
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
          { name: "ConditionalAccessStatus", type: "string" }
        ],
        rows: [
          ["2026-03-02T12:01:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "50074", "MFA required, user did not complete", '{"displayName":"Unknown","isCompliant":false}', "failure"],
          ["2026-03-02T12:03:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "50074", "MFA required, user did not complete", '{"displayName":"Unknown","isCompliant":false}', "failure"],
          ["2026-03-02T12:05:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "50074", "MFA required, user did not complete", '{"displayName":"Unknown","isCompliant":false}', "failure"],
          ["2026-03-02T12:31:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "0",     "Successfully signed in",             '{"displayName":"Unknown","isCompliant":false}', "success"],
          ["2026-03-02T12:32:00Z", "jsmith@goodwin.com", "185.220.101.47", "Unknown/TOR", "0",     "Successfully signed in",             '{"displayName":"Unknown","isCompliant":false}', "success"]
        ]
      }],
      _mock: true
    };
  }

  if (query.toLowerCase().includes("auditlogs")) {
    return {
      tables: [{
        name: "PrimaryResult",
        columns: ["TimeGenerated", "OperationName", "InitiatedBy", "TargetResources", "Result"],
        rows: [
          ["2026-03-02T12:33:00Z", "Add member to role", '{"user":{"userPrincipalName":"jsmith@goodwin.com"}}', '[{"displayName":"Global Readers"}]', "success"],
          ["2026-03-02T12:34:00Z", "Update user", '{"user":{"userPrincipalName":"jsmith@goodwin.com"}}', '[{"displayName":"John Smith"}]', "success"]
        ]
      }],
      _mock: true
    };
  }

  return {
    tables: [{ name: "PrimaryResult", columns: ["TimeGenerated", "Result"], rows: [["2026-03-02T12:00:00Z", "No results"]] }],
    _mock: true
  };
}

function mockSentinelIncidents() {
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
          relatedEntities: [{ kind: "Account", properties: { upn: "jsmith@goodwin.com" } }]
        }
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
          relatedEntities: [{ kind: "Account", properties: { upn: "bwilliams@goodwin.com" } }]
        }
      }
    ],
    _mock: true
  };
}

function mockXdrAlert(alert_id, platform) {
  return {
    id: alert_id,
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
        sha256: "a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"
      },
      {
        entityType: "NetworkConnection",
        remoteIpAddress: "185.220.101.47",
        remotePort: 4444,
        protocol: "TCP"
      }
    ],
    _mock: true
  };
}

function mockXdrHostSearch(hostname, platform) {
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
        firstEventTime: "2026-03-02T12:30:00Z"
      }
    ],
    _mock: true
  };
}

function mockUserInfo(upn) {
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
      defaultMfaMethod: "microsoftAuthenticatorPush"
    },
    groups: ["All Staff", "Litigation", "SharePoint-Legal-RW"],
    devices: [
      { displayName: "LAPTOP-JS4729", operatingSystem: "Windows 11", isCompliant: true, lastSignIn: "2026-03-02T11:00:00Z" }
    ],
    riskState: "atRisk",
    riskLevel: "high",
    riskLastUpdated: "2026-03-02T12:35:00Z",
    _mock: true
  };
}

function mockPasswordReset(upn, revoke_sessions) {
  const mockTempPassword = "Temp@" + Math.random().toString(36).slice(2, 10).toUpperCase() + "!9";
  return {
    success: true,
    upn,
    temporaryPassword: mockTempPassword,
    sessionRevoked: revoke_sessions,
    auditLogId: "AUDIT-" + Date.now(),
    completedAt: new Date().toISOString(),
    _mock: true
  };
}

function mockIsolateMachine(hostname, machine_id, platform, isolation_type) {
  return {
    success: true,
    hostname,
    platform,
    isolation_type,
    machineId: machine_id || "a1b2c3d4e5f6",
    actionId: "ACTION-" + Date.now(),
    status: "Pending",
    completedAt: new Date().toISOString(),
    _mock: true
  };
}

function mockUnisolateMachine(hostname, platform) {
  return {
    success: true,
    hostname,
    platform,
    actionId: "ACTION-" + Date.now(),
    status: "Pending",
    _mock: true
  };
}