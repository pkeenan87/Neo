# Server-Side Admin Skills

> Allow administrators to create reusable skills — markdown files that chain existing tools together with custom instructions — so users can invoke complex multi-step workflows with a single natural-language request.

## Problem

Today, every investigation starts from scratch. A user asking "investigate a TOR login for jsmith@contoso.com" relies entirely on Claude choosing the right tools in the right order with the right parameters. There is no way for an admin to codify their team's best-practice runbooks into reusable, repeatable workflows. This means:

- Investigation quality varies based on how the user phrases their request.
- Institutional knowledge (e.g. "always check MFA status before resetting a password", "query these specific KQL tables for TOR indicators") lives in people's heads, not in the system.
- New analysts get inconsistent results compared to experienced users who know the right prompts.

Tools like Claude Code solve this with "skills" — markdown files that provide structured instructions the AI follows when a particular task is invoked. Neo needs the same concept, but server-managed by admins rather than user-created.

## Goals

- Allow admins to create, update, and delete skill files on the server via API or filesystem
- Skills are markdown documents with a structured format (title, description, steps, tool references, output format)
- When a user's request matches a skill, the agent follows the skill's instructions — calling the specified tools in order with the described logic
- Skills are injected into the system prompt context so Claude is aware of available workflows
- Skills respect the existing permission model — a reader cannot trigger a skill that requires destructive tools
- Skills are discoverable — users can ask "what skills are available?" and get a list

## Non-Goals

- Users creating or editing their own skills (admin-only management)
- A visual skill editor or builder UI (skills are authored as markdown files)
- Changing the underlying tool execution system or agent loop
- Adding new tools — skills compose existing tools only
- Parameterized skill templates with variable substitution at invocation time (skills are instructions, not scripts)
- Approval workflows for skill changes (admins are trusted)

## User Stories

1. **As an admin**, I can create a markdown skill file that describes a multi-step investigation workflow (e.g. "TOR Login Investigation") so that any analyst on my team can invoke it and get consistent, thorough results.
2. **As an admin**, I can update or delete existing skills via the API without restarting the server, so I can iterate on runbooks as our processes evolve.
3. **As an analyst**, I can say "run the TOR login investigation for jsmith@contoso.com" and the agent follows the admin-defined steps — querying the right tables, checking the right indicators, and producing a structured report.
4. **As an analyst**, I can ask "what skills are available?" and see a list of all skills with their descriptions, so I know what workflows my admin has configured.
5. **As a reader-role user**, I cannot trigger a skill that includes destructive tools (e.g. password reset), even if the skill exists. The agent tells me I lack permission for that workflow.
6. **As an admin**, I can create a skill that includes a destructive containment step (e.g. "if compromise is confirmed, reset the user's password"), and when an admin-role user invokes it, the confirmation gate still applies before execution.

## Design Considerations

### Skill File Format

Skills should be markdown files with a consistent structure that Claude can parse and follow. The format should be human-readable and easy to author in any text editor. A skill file might look like:

```
# Skill: TOR Login Investigation

## Description
Investigate a user account flagged for sign-ins from TOR exit nodes.

## Parameters
- upn: The user principal name to investigate

## Steps
1. Look up the user's profile and MFA status using get_user_info
2. Query SigninLogs for the past 7 days filtering for the user's UPN, focusing on sign-ins from anonymizing networks
3. Check if any sign-in IPs appear in known TOR exit node lists by querying ThreatIntelligenceIndicator
4. Review AuditLogs for any privilege escalation or role changes for the user in the same time window
5. If MFA is not registered and TOR sign-ins are confirmed, recommend immediate password reset and session revocation
6. If MFA is registered and sign-ins were MFA-approved, flag as potential MFA fatigue attack

## Output Format
Present findings as a structured incident summary with: Timeline, Evidence, Risk Assessment (HIGH/MEDIUM/LOW), and Recommended Actions.

## Required Tools
- get_user_info
- run_sentinel_kql

## Required Role
reader
```

### Skill Storage

Skills should be stored on the server filesystem in a dedicated directory (e.g. `web/skills/`). The server watches the directory for changes (similar to how `api-keys.json` is hot-reloaded) so admins can add or modify skills without restarting. An API endpoint also allows CRUD operations for admins who prefer not to edit files directly.

### Skill Injection into Agent Context

When the agent loop starts, all available skills (filtered by the user's role) are summarized and appended to the system prompt. This gives Claude awareness of what workflows are available. The full skill content is included so Claude can follow the steps when a user invokes one. If the skill set grows large, only skill summaries (name + description) are injected into the system prompt, and the full skill content is fetched on-demand when Claude decides to follow a specific skill.

### Skill Matching

Skill invocation is natural-language based — the user does not need to know a skill's exact name or use a special syntax. Claude matches the user's request to an available skill based on the description and context. If multiple skills could apply, Claude should ask the user which one to use.

### Permission Integration

Each skill declares a `Required Role` (either `reader` or `admin`). Skills that reference destructive tools must declare `admin` as the required role. The server validates this at load time — a skill that references a destructive tool but declares `reader` as the required role is rejected with a warning. At invocation time, the agent checks the user's role against the skill's required role before following the instructions.

### API Endpoints

Admin-only API endpoints for skill management:

- `GET /api/skills` — List all skills (available to all authenticated users for discovery)
- `GET /api/skills/:id` — Get a single skill's full content (available to all authenticated users)
- `POST /api/skills` — Create a new skill (admin only)
- `PUT /api/skills/:id` — Update an existing skill (admin only)
- `DELETE /api/skills/:id` — Delete a skill (admin only)

### Hot-Reload

The server watches the skills directory for filesystem changes and reloads skills automatically, similar to the existing `api-keys.json` hot-reload pattern. API-created skills are written to the same directory, so both management methods stay in sync.

## Validation

- An admin can create a skill file in the skills directory and it is automatically loaded without server restart
- An admin can create a skill via the POST API and it appears in subsequent GET requests
- A user can ask "what skills are available?" and see a list of loaded skills with descriptions
- A user can invoke a skill by describing the task naturally (e.g. "run a TOR investigation on jsmith@contoso.com") and the agent follows the skill's steps
- A reader-role user cannot invoke a skill that requires the admin role
- A skill that references a destructive tool but declares `reader` as the required role is rejected at load time
- The confirmation gate still applies when a skill triggers a destructive tool — the agent pauses for human confirmation
- Updating a skill file on disk causes the server to reload it within a few seconds
- Deleting a skill via the API removes it from the skills directory and from the loaded skill set
