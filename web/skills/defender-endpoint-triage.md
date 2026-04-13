# Skill: Defender Endpoint Alert Triage

## Description

Automated first-pass investigation of Microsoft Defender for Endpoint alerts. Investigates the alert's process tree, cross-references user activity, checks threat intelligence on file hashes, and assesses lateral movement indicators to produce a triage verdict.

## Required Tools

- get_xdr_alert
- search_xdr_by_host
- run_sentinel_kql
- get_user_info
- get_machine_isolation_status

## Required Role

reader

## Parameters

- alertId
- hostname
- username

## Steps

Follow these steps to investigate the Defender endpoint alert:

### 1. Retrieve Alert Details

Use `get_xdr_alert` with the alert ID from the triage payload to retrieve the full alert record including the process tree, evidence timeline, and MITRE technique mapping. If the alert ID is not directly available as a Defender alert ID, extract it from the triage payload's `raw` field.

### 2. Assess the Process Tree

Examine the process chain reported in the alert. Determine whether:
- The parent process is a known legitimate application (e.g., explorer.exe, svchost.exe, services.exe)
- The child process execution pattern is consistent with normal administrative activity
- Any command-line arguments contain obfuscation (base64 encoding, concatenated strings, uncommon flags)
- The file path is a standard system location or a temporary/unusual directory

If the process tree looks like standard IT tooling (SCCM, Intune, GPO scripts), note this as a benign indicator. If it involves LOLBins (certutil, mshta, regsvr32, rundll32) with suspicious arguments, note this as a threat indicator.

### 3. Check Host Context

Use `search_xdr_by_host` to pull all recent alerts and detections on the affected device. Look for:
- Other alerts in the same time window (clustering suggests a real incident)
- Historical false positives on this host (recurring benign alerts reduce severity)
- The machine's risk score and exposure level

Use `get_machine_isolation_status` to check whether the device is already isolated or pending isolation.

### 4. Check User Context

Use `get_user_info` to retrieve the account profile for any user entities in the alert. Assess:
- Is the account a privileged admin, service account, or standard user?
- Does the user's role explain the observed activity (e.g., IT admin running PowerShell)?
- Are there any active risk flags or recent password resets?

### 5. Query Sentinel for Corroborating Evidence

Use `run_sentinel_kql` to run targeted queries:

**Sign-in anomalies** — check if the user had suspicious sign-in activity around the alert time (TOR, VPN, impossible travel, new device/location).

**Lateral movement** — check if the device communicated with other internal hosts on non-standard ports around the alert time.

**File reputation** — if the alert includes file hashes, check the DeviceFileEvents table for other hosts that have seen the same file.

### 6. Formulate Verdict

Based on all evidence gathered:
- If the activity is clearly legitimate (known admin tool, expected user, no corroborating indicators): verdict **benign** with high confidence.
- If there are multiple threat indicators (suspicious process + anomalous sign-in + lateral movement): verdict **escalate** with supporting evidence.
- If evidence is mixed or incomplete: verdict **inconclusive** and explain what additional investigation is needed.

Always explain your reasoning step by step. Cite specific query results and tool outputs in your evidence.
