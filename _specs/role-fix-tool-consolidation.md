# Web Role Mapping Fix and Tool Call Consolidation

> Fix incorrect role assignment for Entra ID web users (admins getting "reader") and consolidate tool call messages into a single response per user prompt instead of separate message bubbles.

## Problem

Two distinct UX-impacting issues exist in the web interface:

1. **Admin users get "reader" role** — When a user logs in via Entra ID through the browser, the JWT callback in `auth.ts` reads `account.roles` to determine the user's application role. However, Entra ID places app role claims on the `profile` object (the decoded ID token), not the `account` object. Since `account.roles` is always `undefined`, the fallback logic assigns every Entra ID user the `"reader"` role regardless of their actual role assignment in Entra. This means admin users cannot approve destructive actions (password reset, machine isolation) when using the web interface.

2. **Tool calls render as separate messages** — When the agent executes tools during a response, each `tool_call` event is streamed independently and the client creates a new assistant message bubble for each one (e.g., "Running tool: query_sentinel_incidents"). This results in a noisy chat where a single agent turn may produce 3-5 separate message bubbles before the actual response. The user expects one cohesive response per prompt, with tool activity summarized within or appended to that response.

## Goals

- Fix the Entra ID role mapping so that users with the "Admin" app role in Entra are correctly assigned the `"admin"` role in the application
- Consolidate all tool call indicators and the final response into a single message bubble per agent turn
- Provide a brief tool activity summary (which tools ran) at the bottom of the response message
- Maintain the existing streaming UX where the user sees activity happening in real-time (e.g., a thinking/processing indicator while tools run)

## Non-Goals

- Changing the role definitions or adding new roles beyond `admin` and `reader`
- Displaying tool input/output details in the chat (just tool names as a summary)
- Modifying the CLI tool call display behavior
- Changing the Teams bot message format
- Adding role management UI or self-service role assignment

## User Stories

1. **As an admin SOC analyst**, when I log in via the web using my Entra ID account that has the "Admin" app role, I am correctly assigned the admin role and can approve destructive containment actions.
2. **As a SOC analyst**, when I send a prompt that triggers multiple tool calls, I see a single response message that includes the assistant's answer and a brief summary of which tools were used, rather than a separate message for each tool.
3. **As a SOC analyst**, while the agent is processing my request and calling tools, I still see a real-time indicator that work is happening (thinking/processing state), so I know the system is responsive.

## Design Considerations

### Role Mapping Fix

The fix is in the `jwt` callback of `auth.ts`. The code currently reads `account.roles` but should read `profile.roles` to get the Entra ID app role claims from the decoded ID token. The `profile` parameter in the NextAuth JWT callback contains the full set of claims from the identity provider, including the `roles` array that Entra ID populates based on App Role assignments.

The existing role-checking logic (`roles?.includes("Admin") ? "admin" : "reader"`) is correct — only the source object needs to change. The allowlist pattern in `auth-helpers.ts` that validates roles on API requests does not need modification.

Consider adding a debug log when the role is resolved so that role mapping issues are easier to diagnose in the future.

### Tool Call Message Consolidation

Currently the data flow is:
1. Agent loop detects a tool use → fires `onToolCall` callback immediately
2. Route handler writes a `tool_call` NDJSON event to the stream
3. Client receives the event and creates a new `ChatMessage` in state
4. After all tools complete, `writeAgentResult` writes a single `response` event
5. Client creates another message for the response

The desired behavior:
1. Tool calls should still stream to the client in real-time (so the user sees activity)
2. But instead of creating separate messages, the client should accumulate tool names during a turn
3. When the final `response` event arrives, the client creates one message that combines the response text with a tool summary footer

This is primarily a **client-side rendering change** in `ChatInterface.tsx`. The server-side event emission can remain the same — individual `tool_call` events are still useful for real-time feedback. The change is in how `processNDJSONStream` handles these events:
- Instead of appending a new message per `tool_call`, accumulate tool names in a temporary array
- When the `response` event arrives, append the tool summary to the response text and create one message
- While tools are running (before the response), show a transient processing indicator (already exists as the loading state) rather than individual tool messages

### Edge Cases

- **Confirmation-required tools**: When a destructive tool triggers a confirmation gate, the tool call should still appear in the summary. The confirmation dialog is separate UI and should remain as-is.
- **Multiple agent turns**: Each user prompt should result in one consolidated response. If the agent loop iterates multiple times (calling tools, getting results, calling more tools), all tool calls within that turn should be collected into one summary.
- **No tools called**: If the agent responds without calling any tools, the message should render normally with no tool summary section.
- **Error during tool execution**: If a tool fails or the stream errors, any accumulated tool names should not be lost — show whatever was collected.

## Open Questions

1. **Tool summary format** — Should the tool summary be a simple comma-separated list (e.g., "Tools used: query_sentinel_incidents, get_user_details") or a bulleted list? Should it be visually distinct (smaller text, muted color)?
2. **Tool summary position** — Should the tool summary appear at the top of the response (before the assistant's text) or at the bottom (after the text)? The user mentioned "at the bottom."
3. **Thinking indicator during tools** — The current loading spinner says "Processing..." while tools run. Should this be enhanced to show which tool is currently running (e.g., "Running query_sentinel_incidents..."), or is the generic indicator sufficient?
