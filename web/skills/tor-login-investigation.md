# Skill: TOR Login Investigation

## Description

Investigate a user account flagged for sign-in activity from a TOR exit node. This skill walks through a complete investigation from initial triage to containment recommendation.

## Required Tools

- run_sentinel_kql
- get_user_info
- get_sentinel_incidents
- search_xdr_by_host

## Required Role

reader

## Parameters

- upn
- timeframe

## Steps

Follow these steps in order when investigating a TOR login alert:

### 1. Gather User Context

Call `get_user_info` for the reported UPN to establish:
- Account status (enabled/disabled)
- MFA registration status
- Risk level
- Group memberships (especially privileged groups)
- Recent devices

### 2. Confirm the TOR Login

Run a KQL query against `SigninLogs` for the reported user and timeframe:
```kql
SigninLogs
| where TimeGenerated > ago({timeframe})
| where UserPrincipalName == "{upn}"
| where NetworkLocationDetails has "tor" or IPAddress in (externaldata(ip:string) [@"https://check.torproject.org/torbulkexitlist"])
| project TimeGenerated, IPAddress, Location, AppDisplayName, ResultType, ConditionalAccessStatus, DeviceDetail, NetworkLocationDetails
| order by TimeGenerated desc
```

If no direct TOR indicators, broaden to check for anonymous/proxy IPs:
```kql
SigninLogs
| where TimeGenerated > ago({timeframe})
| where UserPrincipalName == "{upn}"
| where RiskLevelDuringSignIn in ("high", "medium") or RiskEventTypes has "anonymizedIPAddress"
| project TimeGenerated, IPAddress, Location, AppDisplayName, ResultType, RiskLevelDuringSignIn, RiskEventTypes
| order by TimeGenerated desc
```

### 3. Check for Impossible Travel

```kql
SigninLogs
| where TimeGenerated > ago({timeframe})
| where UserPrincipalName == "{upn}"
| project TimeGenerated, IPAddress, Location, AppDisplayName
| order by TimeGenerated asc
```

Look for logins from geographically distant locations within a short time window (< 2 hours).

### 4. Check for Post-Compromise Activity

Look for privilege escalation or suspicious actions after the flagged login:
```kql
AuditLogs
| where TimeGenerated > ago({timeframe})
| where InitiatedBy has "{upn}"
| project TimeGenerated, OperationName, TargetResources, Result
| order by TimeGenerated desc
```

Also check for mail forwarding rules or data access:
```kql
OfficeActivity
| where TimeGenerated > ago({timeframe})
| where UserId == "{upn}"
| where Operation in ("New-InboxRule", "Set-InboxRule", "FileDownloaded", "FileAccessed")
| project TimeGenerated, Operation, ClientIP, ResultStatus
| order by TimeGenerated desc
```

### 5. Check Endpoint Telemetry

Use `search_xdr_by_host` to check the user's recent devices for any related alerts.

### 6. Assess and Recommend

Provide a structured assessment:
- **Confidence level**: HIGH / MEDIUM / LOW that this is a true compromise
- **Evidence summary**: List key findings
- **Risk factors**: Privileged account? MFA bypass? Data access?
- **Alternative hypotheses**: VPN, travel, false positive
- **Recommended actions**: Based on confidence level:
  - HIGH: Recommend password reset + session revocation + machine isolation if needed
  - MEDIUM: Recommend password reset + monitoring
  - LOW: Recommend monitoring and user contact for verification
