# Skill: Legal Sector Threat Intelligence

## Description
Performs a threat intelligence analyst workflow specifically for the legal industry. Neo will reason through this the same way a security analyst does:

1. IDENTIFY — What threat actors are currently targeting law firms? What new behaviours, campaigns, or TTPs have emerged recently? This includes ransomware groups, data extortion groups, nation state actors, and criminal supergroups targeting professional services.

2. UNDERSTAND — What is the behaviour behind the threat? Not just IOCs — but how are they getting in, what do they do once inside, what tools do they use, how do they exfiltrate, how do they extort? Why are law firms being targeted specifically?

3. TRANSLATE — Convert those behaviours into technical indicators. What would this look like in our logs? What process names, registry keys, file extensions, DNS patterns, network connections, or user behaviours would appear in Sentinel, Defender XDR, ThreatLocker, or AppOmni?

4. CONTEXTUALISE — What does this mean for us specifically? What vendor supply chain risks are we exposed to? What tools and platforms do we use that are being actively exploited? Where are our identity and SaaS posture gaps?

5. ACT — Based on the analysis above, what should we do right now? This is the only step where Neo touches the environment — and only after completing steps 1 through 4 first.

This skill is the analytical chain from raw threat intelligence to actionable detection. Neo should always explain its reasoning at each step — not just what it found, but why it matters.

⚠️ Neo must never take a destructive action without presenting evidence, re-examining for false positives, stating confidence level, and receiving explicit confirmation from the analyst.

## Required Tools
- run_sentinel_kql
- get_user_info
- list_threatlocker_approvals
- list_appomni_findings
- list_appomni_policy_issues
- block_indicator
- get_sentinel_incidents

## Required Role
admin

## Parameters
- `focus` — what to focus on: `latest_campaigns`, `specific_actor`, `new_behaviours`, `supply_chain_risk`, `full_assessment`
- `actor` — optional, name a specific actor to deep dive on
- `translate_to_hunt` — if true, Neo proceeds to ACT after completing the analysis. Default false — analysis and recommendations only unless explicitly requested
- `timespan` — how far back to look when hunting (ISO 8601, default `P7D`). Only used if `translate_to_hunt` is true
- `hostname` — optional, scope hunt to a specific device
- `user` — optional, scope hunt to a specific user UPN

## Steps

Follow these steps in order. Complete each step fully before moving to the next. Always explain reasoning — not just what was found, but why it matters.

### 1. IDENTIFY — What is hitting law firms right now?

Using your current knowledge of the threat landscape, reason through:

- Which threat actors are actively targeting law firms and legal services organisations right now?
- What campaigns, leak site postings, or confirmed victims have emerged recently?
- Have any actors changed their TTPs, tooling, or targeting patterns recently?
- Are there any active supply chain events — vendor breaches, SaaS integrator compromises, credential leaks — that could feed downstream attacks on law firms?
- What nation state actors are pre-positioning or conducting espionage against professional services?

Focus on actors and campaigns that are current and relevant — not historical. The threat landscape changes weekly. Reason from the most recent intelligence available to you.

If `focus` is `specific_actor`, concentrate entirely on the named `actor` parameter.
If `focus` is `supply_chain_risk`, concentrate on vendor and third-party breach exposure.
If `focus` is `new_behaviours`, concentrate on what has changed recently in actor TTPs.
If `focus` is `full_assessment`, cover all active actors and all supply chain risks.

### 2. UNDERSTAND — What is the behaviour behind the threat?

For each relevant actor identified in step 1, reason through their full attack chain without relying on static IOC lists:

- How do they achieve initial access?
- What do they do in the first hour after access?
- How do they move laterally?
- What data do they target and why is legal sector data specifically valuable to them?
- How do they exfiltrate?
- How do they extort — encryption, data leaks, regulatory threats, competitor notification?
- What makes their approach difficult to detect with traditional tools?

Reason about why law firms are high-value targets — the nature of the data they hold, regulatory obligations around confidentiality, willingness to pay to protect client privilege, and the firm's reliance on third-party legal technology vendors.

Do not move to step 3 until the behaviour is fully understood for each relevant actor.

### 3. TRANSLATE — What does this look like in our environment?

Convert the behaviours from step 2 into observable indicators specific to this environment. For each actor reason through what their activity would produce across each detection layer:

**Sentinel / Defender XDR** — what process executions, file operations, registry changes, network connections, or authentication events would appear?

**ThreatLocker** — what application approval requests would attacker tooling generate?

**AppOmni** — what SaaS posture gaps or OAuth activity would indicate exposure or compromise?

**Identity layer** — what authentication anomalies, MFA patterns, or service principal behaviour would be visible in Entra sign-in and audit logs?

For each indicator, also reason through what a false positive looks like — what legitimate activity could produce the same signal. This prevents noise and builds defensible detections.

### 4. CONTEXTUALISE — What does this mean for us specifically?

Reason through the firm's specific exposure without assuming answers. Use the available tools to discover current state:

**Vendor and supply chain exposure:**
- Call `list_appomni_discovered_apps` to identify what third-party SaaS integrations are connected to the environment
- Reason about which of those integrations match vendors or platforms that have recently been breached or exploited
- Consider the pattern: vendor breach → data harvested → weeks later → targeted attack via different vector

**SaaS and identity posture:**
- Call `list_appomni_findings` and `list_appomni_policy_issues` to discover current open posture gaps
- Reason about which gaps map directly to active actor TTPs identified in step 1
- Prioritise findings that remove authentication controls entirely — legacy auth, MFA gaps, SSO bypass paths

**Service principal and OAuth exposure:**
- Run a Sentinel query to enumerate active service principals with high-volume Graph, Exchange, or SharePoint access
- Flag any service principals with generic names, unknown ownership, or unusual IP patterns for review

**What a clean hunt result actually means:**
State explicitly that a clean result does not confirm safety — it confirms no detected activity within the scope of what was hunted. Reason about what the environment cannot currently see — unmonitored systems, missing log sources, blind spots — and name them.

### 5. ACT — Recommendations and hunting

Based on steps 1 through 4, produce two outputs:

**A. Recommended actions — always produced:**

Prioritise by urgency and map each recommendation directly to the specific threat or gap it addresses:
- **IMMEDIATE** — this week, based on active live campaigns
- **SHORT-TERM** — next 30 days, based on posture gaps that map to active TTPs
- **STRATEGIC** — next quarter, architectural or capability improvements

Do not produce generic security advice. Every recommendation must trace back to a specific actor, behaviour, or gap identified in the analysis above.

**B. Active hunting — only if `translate_to_hunt` is true:**

Based on the translation work in step 3, write and run KQL queries via `run_sentinel_kql`. Neo decides which queries to write based on its own reasoning from steps 1 through 3 — the queries are not prescribed. Write the queries most likely to surface evidence of the specific actors and behaviours identified as relevant.

After each query, explain what was found and what it means before running the next one.

Then:
- Call `list_threatlocker_approvals` and reason about whether any pending requests match attacker tooling patterns identified in step 3
- Review AppOmni findings already retrieved in step 4 and reason about which require immediate attention
- For any suspicious user identified, call `get_user_info` and reason about their risk profile

**IOC blocking — confirmation required:**
If confirmed IOCs are identified, present the IOC, the supporting evidence, the confidence level, and the false positive risk. Then ask the analyst explicitly:

> "I have identified [IOC] as a confirmed indicator based on [evidence]. Confidence: [HIGH/MEDIUM]. Blocking this will affect all enrolled devices. Do you want me to proceed?"

Only call `block_indicator` after receiving an explicit YES.

### 6. Summarise

Always close with a structured summary:

- **Threat picture** — what is actively targeting legal firms right now and why it matters for this firm specifically
- **Our exposure** — where the firm is specifically vulnerable based on what was discovered in step 4
- **What was found** — if `translate_to_hunt` was true, what the hunt produced and what it means in context
- **What was actioned** — any IOCs blocked, users enriched, findings raised — or explicitly state nothing was actioned and why
- **Residual risk** — what blind spots remain that limit detection confidence, and what would need to change to close them
- **Recommended next steps** — the prioritised actions from step 5A
