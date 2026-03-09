# Web Role Mapping Fix and Tool Call Consolidation

## Context

Two issues affect the web interface: (1) all Entra ID users get the "reader" role because the JWT callback reads `account.roles` instead of `profile.roles`, and (2) each tool call during an agent turn creates a separate chat message instead of being consolidated into one response. This plan fixes the one-line role bug and rearchitects the client-side stream handling to accumulate tool calls and render them as a bulleted summary at the bottom of a single response message.

---

## Key Design Decisions

- **Role fix is a source-object change only** — change `account` to `profile` on line 67 of `auth.ts`. No other auth logic changes. The existing `includes("Admin")` check and role allowlisting in `auth-helpers.ts` remain intact.
- **Tool consolidation is client-side only** — the server continues to emit individual `tool_call` events during execution. The change is entirely in how `ChatInterface.tsx` processes these events: accumulate tool names instead of creating messages, then combine with the response.
- **Live activity indicator enhanced** — the loading/thinking indicator text updates to show which tool is currently running (e.g., "Running query_sentinel_incidents...") instead of generic "Processing...", giving real-time feedback without adding messages.
- **Tool summary is a styled bulleted list** — rendered at the bottom of the response message in a visually distinct section (smaller, muted text) using a new CSS module class.
- **No server-side event changes** — keeping `tool_call` events as-is preserves backward compatibility and allows future consumers to handle them differently.

---

## Files to Change

| File | Change |
|------|--------|
| `web/auth.ts` | Change role extraction from `account.roles` to `profile.roles` on line 67 |
| `web/components/ChatInterface/ChatInterface.tsx` | Rework `processNDJSONStream` to accumulate tool names instead of creating per-tool messages; combine tool summary with response; update thinking indicator to show current tool name |
| `web/components/ChatInterface/ChatInterface.module.css` | Add `.toolSummary` and `.toolSummaryItem` classes for the visually distinct tool list at the bottom of responses |

---

## Implementation Steps

### 1. Fix Entra ID role mapping

- In `web/auth.ts`, line 67, change the source of `idTokenRoles` from `(account as Record<string, unknown>).roles` to `(profile as Record<string, unknown>).roles`
- The `profile` parameter is already available in the `jwt` callback signature and is already used on line 77 for `oid` extraction
- Add a `logger.debug` call after the role is determined (line 74, before the closing brace of the Entra ID block) logging the resolved role and provider for future diagnostics — import `logger` from `@/lib/logger` at the top of the file

### 2. Add tool summary CSS classes

- In `web/components/ChatInterface/ChatInterface.module.css`, add a `.toolSummary` class for the container of the tool list: top border separator (1px solid, using the same border color as message bubbles), top margin of 0.75rem, top padding of 0.75rem, font-size 0.75rem, muted text color (#94a3b8 in light, rgba(34,197,94,0.4) in dark)
- Add a `.toolSummaryItem` class for each tool bullet: display flex, gap 0.25rem, align-items center. Use a small bullet character or the same muted color
- Add a `.toolSummaryLabel` class for the "Tools used:" header text: font-weight 500, margin-bottom 0.25rem

### 3. Add thinking tool name state

- In `ChatInterface.tsx`, add a new state variable `currentToolName` of type `string | null`, initialized to `null`
- When the thinking indicator renders (the loading state section around line 697), instead of always showing "Processing...", show `Running ${currentToolName}...` when `currentToolName` is not null, and "Processing..." otherwise
- Reset `currentToolName` to `null` in `handleSendMessage` before the fetch call, and in `handleConfirmAction` before the fetch call

### 4. Rework processNDJSONStream to accumulate tool calls

- Add a local mutable array `const toolsUsed: string[] = []` at the top of `processNDJSONStream`
- In the `tool_call` case (currently lines 387-396): instead of calling `setMessages` to create a new message, push `event.tool` into `toolsUsed` and call `setCurrentToolName(event.tool)` to update the thinking indicator. Do NOT create a new ChatMessage.
- In the `response` case (currently lines 408-413): build the message content by combining `event.text` with the tool summary. If `toolsUsed.length > 0`, append a markdown section to the response text. Format: two newlines, then a line like `\n\n---\n**Tools used:**\n` followed by each tool as `- \`toolname\`\n`. Then create the single ChatMessage with this combined content.
- In the `thinking` case: this is already a no-op (just `break`), which is correct since the thinking indicator is driven by the `isLoading` state.
- After the stream processing loop completes (after the `while(true)` loop), call `setCurrentToolName(null)` to clear the tool indicator.

### 5. Handle edge cases in tool accumulation

- **Confirmation-required tools**: The `confirmation_required` case currently creates a message about the pending action. Keep this behavior — it's not a tool summary, it's a distinct confirmation prompt. The tool that triggered confirmation should still be included in `toolsUsed` since the `tool_call` event fires before the confirmation gate.
- **Error events**: If an `error` event arrives after tools have been accumulated, the tool summary would be lost because no `response` event fires. In the `error` case, if `toolsUsed.length > 0`, append the tool summary to the error message the same way as for responses.
- **Stream ends without response**: After the `while(true)` loop, if `toolsUsed.length > 0` and no response/error event was received, this is an edge case (stream interrupted). The tools are lost, which is acceptable since the UI will show a generic error state.

### 6. Render tool summary with CSS module classes

- The tool summary is embedded in the markdown content of the response message, so the `MarkdownRenderer` will handle the markdown formatting (the `---`, bold text, and bullet list)
- However, for visual distinction, wrap the tool summary section in a recognizable pattern that can be styled. Use a specific HTML structure: after the markdown response text, add a `div` with `className={styles.toolSummary}` containing the tool list
- Since the message content is a string rendered through `MarkdownRenderer`, an alternative approach: embed the summary as markdown in the string content. The `---` horizontal rule, bold header, and code-backtick tool names will render correctly through the existing MarkdownRenderer. No wrapper div needed — the markdown styling handles it.
- The muted visual distinction will come from the `---` separator and the smaller tool name formatting (backtick code spans render in a different style)

### 7. Verify the role fix does not break API key auth

- The change in `auth.ts` only affects the `account.provider === "microsoft-entra-id"` branch. The `account.provider === "api-key"` branch on line 82 is untouched and continues to read role directly from the user object returned by the `authorize` function.
- The dev bypass in `get-auth-context.ts` (which returns `"admin"` for `DEV_AUTH_BYPASS=true`) is also unaffected.

---

## Verification

1. `cd web && npm run build` — zero errors, confirming no type or import issues
2. **Role fix**: Log in via Entra ID with an account that has the "Admin" app role assignment. Confirm that the session shows `userRole: "admin"` in the UI (visible in the sidebar clearance badge) and that destructive tools are available.
3. **Role fix (negative)**: Log in with an account that does NOT have the "Admin" app role. Confirm role is "reader" and destructive tools are not offered.
4. **Tool consolidation**: Send a prompt that triggers tool calls (e.g., "show me recent security incidents"). Confirm that:
   - No separate "Running tool: X" messages appear in the chat
   - The thinking indicator shows "Running query_sentinel_incidents..." while tools execute
   - The final response message includes the assistant text followed by a separator and "Tools used:" with a bulleted list of tool names
5. **No tools**: Send a simple prompt that doesn't trigger tools (e.g., "hello"). Confirm the response renders normally with no tool summary section.
6. **Confirmation flow**: Trigger a destructive tool (e.g., "reset the password for user@example.com"). Confirm the confirmation dialog still appears correctly and tool calls prior to the confirmation are summarized in any preceding response.
7. **Error handling**: If possible, trigger an agent error and verify tool names accumulated before the error are included in the error message display.
