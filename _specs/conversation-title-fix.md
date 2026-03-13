# Spec for Conversation Title Fix

branch: claude/feature/conversation-title-fix

## Summary

CLI and Teams conversations are stored in Cosmos DB without titles, showing as "Untitled" in the history list. The web channel generates titles correctly via `extractAutoTitle()` in `stream.ts`, but the Teams route calls `saveMessages()` without passing a title, and the CLI route relies on the same `writeAgentResult()` path as web — which should work but may be failing silently. Additionally, the `title-generator.ts` module (which uses a Haiku model call for richer titles) exists but is never imported or used anywhere. The user also reported seeing a failed Sonnet model call in the logs, suggesting a prior attempt to wire up LLM-based title generation may have been misconfigured or removed.

## Functional requirements

- All channels (web, CLI, Teams) must produce a conversation title after the first agent response
- The title should be derived from the first user message (the current `extractAutoTitle` approach) as the baseline
- Optionally, the existing `title-generator.ts` Haiku-based generation should be wired up as an enhancement for higher-quality titles (e.g., "Suspicious Login from Russia" instead of the raw user prompt)
- Title generation must never block or delay the agent response — it should be fire-and-forget
- If title generation fails, the conversation should still have a fallback title (first user message or "New conversation")
- Titles must be set only once — subsequent messages should not overwrite the title

## Possible Edge Cases

- The first user message is very long (200+ chars) — should be truncated with ellipsis
- The first user message is empty or contains only whitespace — fallback to "New conversation"
- The first user message contains control characters, HTML, or markdown — should be sanitized
- Multiple messages arrive rapidly in Teams before the first `saveMessages` completes — title should still be set exactly once due to the `if (title && !resource.title)` guard in Cosmos
- The Haiku API call for title generation fails (rate limit, network error, bad API key) — must degrade gracefully to `extractAutoTitle` fallback
- A resumed/expired Teams session creates a new conversation — the new conversation should get its own title from the first new user message, not the summary

## Acceptance Criteria

- Teams conversations have a non-null title in Cosmos DB after the first agent response
- CLI conversations have a non-null title in Cosmos DB after the first agent response
- Web conversations continue to have titles (no regression)
- Titles appear correctly in the `history` command in the CLI
- Titles appear correctly in the web sidebar conversation list
- Title generation does not add latency to the agent response
- Failed title generation logs a warning but does not throw or surface an error to the user

## Open Questions

- Should we wire up the existing `title-generator.ts` (Haiku-based) for richer titles, or is the simple first-message extraction sufficient? yes use the existing
- If using Haiku-based titles, should it apply to all channels or just Teams (where the first message may be more conversational and less suitable as a title)? all channels
- Should `title-generator.ts` be deleted if we decide not to use it, to avoid dead code? keep it.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- `extractAutoTitle` returns a sanitized first user message when present
- `extractAutoTitle` returns undefined when no user message exists
- `extractAutoTitle` truncates messages longer than 200 characters
- The Teams route passes a title to `saveMessages` after the agent loop completes
- Title is not overwritten on subsequent `saveMessages` calls (the `if (title && !resource.title)` guard)
