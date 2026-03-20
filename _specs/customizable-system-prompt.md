# Spec for Customizable System Prompt

branch: claude/feature/customizable-system-prompt

## Summary

The system prompt currently hardcodes "Goodwin Procter LLP" as the organization name. To make Neo deployable to other organizations and to improve investigation quality, two changes are needed: (1) make the company name configurable via an environment variable, and (2) provide a mechanism for injecting custom organizational context — such as domain names, SAM account name formats, network ranges, or other environment-specific knowledge — into the system prompt so Neo can answer questions more accurately.

## Functional requirements

- Add an `ORG_NAME` environment variable (defaulting to "Goodwin Procter LLP") that replaces the hardcoded company name in the `BASE_SYSTEM_PROMPT` in `web/lib/config.ts`
- Add an `ORG_CONTEXT` environment variable (or a file-based mechanism) that allows injecting a free-text block of organizational context into the system prompt
- The organizational context should be appended as a dedicated `## ORGANIZATIONAL CONTEXT` section in the system prompt, positioned after the existing sections
- Example context that an admin might configure: company domain names (`goodwin.com`, `goodwinlaw.com`), SAM account name format (`first.last`), VPN IP ranges, critical asset hostnames, escalation contacts, or any other SOC-relevant knowledge
- If `ORG_CONTEXT` is empty or not set, the section is simply omitted — no placeholder or empty heading
- Both variables should be read at runtime so they can be changed without rebuilding
- The CLI system prompt (if it has its own in `cli/src/config.js`) should also respect the same variables
- Add the new variables to `.env.example` with descriptive comments and example values

## Possible Edge Cases

- Very large `ORG_CONTEXT` values could inflate the system prompt and consume significant context window budget — consider a reasonable character limit with a warning if exceeded
- Special characters in `ORG_NAME` (e.g., ampersands, quotes) should be passed through safely since they're inserted into a template literal, not into HTML or SQL
- If `ORG_NAME` is set to an empty string, fall back to a generic phrase like "your organization" rather than producing "for 's security team"
- Multi-line `ORG_CONTEXT` in environment variables requires `\n` escaping — document this, or consider supporting a file path as an alternative (e.g., `ORG_CONTEXT_FILE=/path/to/context.md`)

## Acceptance Criteria

- Setting `ORG_NAME=Acme Corp` results in the system prompt reading "You are an expert AI security operations analyst for Acme Corp's security team"
- Setting `ORG_CONTEXT` with organizational details results in those details appearing in a dedicated section of the system prompt
- Omitting both variables produces the current default behavior (Goodwin Procter LLP, no extra context section)
- The variables are documented in `.env.example`
- Context window impact is manageable — a warning is logged if `ORG_CONTEXT` exceeds a reasonable threshold (e.g., 2000 characters)

## Open Questions

- Should `ORG_CONTEXT` support loading from a file path in addition to (or instead of) an env var? Multi-line content is easier to manage in a file. yes, file too.
- Should there be a UI in `/settings` for admins to edit the organizational context, or is env-var / file configuration sufficient for now? Yes, UI in settings would be great.
- Should the CLI have its own independent system prompt, or does it already delegate to the web server (making this a web-only change)? already delegates to the server.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases:

- System prompt includes the custom `ORG_NAME` when the env var is set
- System prompt falls back to "Goodwin Procter LLP" when `ORG_NAME` is not set
- System prompt falls back to a generic phrase when `ORG_NAME` is empty string
- Organizational context section is appended when `ORG_CONTEXT` is set
- Organizational context section is omitted when `ORG_CONTEXT` is not set
- A warning is produced when `ORG_CONTEXT` exceeds the character limit threshold
