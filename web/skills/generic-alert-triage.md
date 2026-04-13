# Skill: Generic Alert Triage

## Description

Catch-all automated triage skill for security alerts that don't have a dedicated investigation skill. Performs a broad investigation by pivoting on the alert's entities (users, devices, IPs) across available data sources and produces a triage verdict.

## Required Tools

- run_sentinel_kql
- get_user_info

## Required Role

reader

## Steps

Follow these steps to investigate the alert using the entities provided:

### 1. Identify Pivot Points

Extract the key entities from the alert payload:
- **Users**: email addresses, UPNs, or account names
- **Devices**: hostnames, device IDs
- **IP addresses**: source and destination IPs
- **Files**: filenames, hashes
- **URLs**: any referenced URLs

Prioritize: if users are present, start with user investigation. If only devices or IPs, start there.

### 2. Investigate Users

For each user entity, use `get_user_info` to retrieve their profile. Check:
- Account type (admin, standard, service account)
- Risk flags or recent security events
- Job title and department (does it explain the activity?)

Then use `run_sentinel_kql` to query the user's recent sign-in activity:
- Any sign-ins from unusual locations, TOR exits, or anonymizing proxies
- Sign-ins outside normal business hours
- Multiple failed sign-in attempts followed by a success
- New device or application registrations

### 3. Investigate Devices and IPs

Use `run_sentinel_kql` to check:
- Recent security events on the device (SecurityEvent, DeviceEvents tables)
- Network connections from the device to external IPs
- Any other alerts involving the same device in the past 24 hours

For IP addresses:
- Check if the IP appears in Sentinel threat intelligence (ThreatIntelligenceIndicator table)
- Check if other users or devices have communicated with this IP

### 4. Assess the Alert in Context

Consider:
- The alert severity relative to the evidence found
- Whether the activity matches known patterns of legitimate behavior
- Whether there are corroborating indicators across multiple data sources
- The organization's risk tolerance for this type of alert

### 5. Formulate Verdict

- **benign**: The activity is clearly explainable as normal business operations, with no corroborating threat indicators.
- **escalate**: There are suspicious indicators that warrant analyst review, or the alert type is not familiar enough for automated disposition.
- **inconclusive**: Insufficient data to make a determination. Note what additional tools or data would be needed.

Because this is a generic skill without deep knowledge of the specific alert type, lean toward **escalate** or **inconclusive** when uncertain. Specialized triage skills exist for common alert families and will produce more confident verdicts.
