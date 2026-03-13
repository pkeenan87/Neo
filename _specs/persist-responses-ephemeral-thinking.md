# Spec for Persist Responses and Ephemeral Thinking

branch: claude/feature/persist-responses-ephemeral-thinking

## Summary

Two related improvements to the agent experience:

1. **Persist agent responses to the database from CLI and Teams.** Currently, the web interface persists both user and assistant messages to Cosmos DB via `writeAgentResult()` in `web/lib/stream.ts`. However, the CLI agent loop (`cli/src/agent.js`) operates independently and does not write responses to any persistent store. Teams responses are written via the web API route, but this needs verification that all response paths (including confirmation flows and error cases) consistently persist.

2. **Make thinking indicators ephemeral (flash and disappear).** Currently, thinking events are rendered as permanent "Thinking..." text in the CLI and are silently ignored in the web UI. The desired behavior is to show a brief, animated thinking indicator that disappears once the model begins producing its response — matching the experience in Claude Chat.

## Functional requirements

### Part 1: Response Persistence

- CLI agent responses must be written to the Cosmos DB `conversations` container after each agent loop completes
- The CLI must authenticate against the same Cosmos DB instance used by the web app
- The CLI must create or resume a session/conversation so that messages accumulate across turns
- Teams responses must be audited to confirm all code paths (normal response, confirmation flow, error) persist the full message array
- Both user messages and assistant messages from CLI and Teams must be queryable in the database after a conversation ends

### Part 2: Ephemeral Thinking Indicator

- **Web:** When a `thinking` event is received, display an animated thinking indicator (e.g., pulsing dots or shimmer) in the chat message area. When the next content event arrives (tool_call, response, or error), the thinking indicator must be removed — not left as a permanent message in the history
- **CLI:** Replace the current static `⏳ Thinking...` line with an animated indicator (e.g., spinner or pulsing dots) that is cleared from the terminal once the model begins responding. Use carriage return / ANSI escape codes to overwrite the line
- Thinking indicators must never be stored in the conversation message history or database
- If the agent loop errors out while thinking, the indicator should still be cleared

## Possible Edge Cases

- CLI running without database connectivity (MOCK_MODE=true): should responses still attempt persistence, or skip gracefully?
- Long-running tool calls between thinking and response: the thinking indicator should disappear when the first tool_call event arrives, not linger until the final response
- Multiple consecutive thinking events before a response: should not stack multiple indicators
- Network failure during database write from CLI: should not crash the REPL; log a warning and continue
- Teams message chunking (>20K chars): ensure persistence happens before chunking for delivery, so the full response is stored even if Teams display is split
- Rapid successive messages in web UI: ensure thinking indicator cleanup doesn't race with new message rendering

## Acceptance Criteria

- After a CLI conversation, all user and assistant messages appear in the Cosmos DB `conversations` container with correct session ID
- After a Teams conversation, all user and assistant messages appear in the Cosmos DB `conversations` container
- In the web UI, the thinking indicator appears briefly and disappears when the model starts responding — no residual "Thinking..." messages in chat history
- In the CLI, the thinking line is overwritten/cleared when the model starts responding — no leftover "Thinking..." lines in terminal output
- Thinking indicators are never persisted to the database
- Existing web persistence behavior is unchanged

## Open Questions

- Should the CLI share the same session ID scheme as the web app, or use a separate namespace (e.g., `cli-<uuid>`)? separate
- Should CLI conversations be visible in the web UI's conversation history sidebar, or kept separate? no I want all history contained to the client app. ClI should only see CLI and Web UI should only see chats that originated from the Web UI
- Should there be a CLI flag to opt out of database persistence (e.g., `--no-persist` or respecting `MOCK_MODE`)? no.
- What animation style for the web thinking indicator — pulsing dots, shimmer bar, or skeleton bubble? Skeleton Bubble.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- CLI persistence: verify that after an agent loop completes, the conversation document in Cosmos DB contains the expected user and assistant messages
- Thinking indicator cleanup (web): simulate a stream of events (thinking -> tool_call -> response) and verify the thinking indicator component mounts and unmounts at the correct times
- Thinking indicator cleanup (CLI): verify that the thinking line is cleared from stdout when a subsequent event arrives
- Edge case: thinking event followed immediately by error — indicator should still be removed
- Edge case: multiple thinking events — only one indicator visible at a time
