# CLI Session Token Refresh

> Keep the CLI session authenticated by proactively refreshing Entra ID tokens in the background, preventing mid-session logouts during long investigations.

## Problem

The CLI resolves the auth header once at startup in `resolveServerConfig()` and reuses that static `authHeader` string for the entire REPL session. Entra ID tokens expire (typically after 60–90 minutes). If an analyst is mid-investigation when the token expires, the next API call fails with a 401 and the session is effectively lost. The user must exit the REPL, re-authenticate, and start a new session — losing conversational context.

This is particularly disruptive during long incident response workflows where the analyst has built up significant context with the agent over multiple tool calls.

## Goals

- Entra ID tokens are refreshed automatically in the background while the REPL session is active
- Token refresh happens proactively before expiry, not reactively after a 401
- The analyst never experiences a mid-session logout under normal conditions
- API key auth is unaffected (no expiry concept)
- No user-facing changes to the REPL experience — refresh is invisible

## Non-Goals

- Re-implementing the OAuth login flow (the existing PKCE login stays the same)
- Adding retry logic for failed API calls (if a refresh fails, the error surfaces immediately)
- Changing the server-side token verification
- Handling network-down scenarios gracefully (if the refresh endpoint is unreachable, the token expires naturally)

## User Stories

1. **As a SOC analyst**, I can run a multi-hour investigation in the REPL without being logged out, because the CLI keeps my token fresh in the background.
2. **As a SOC analyst**, I see no difference in the REPL experience — the refresh is silent and invisible.
3. **As a SOC analyst using an API key**, my experience is unchanged because API keys do not expire.

## Design Considerations

### Static Auth Header vs. Dynamic Auth Resolution

The current architecture passes `authHeader` as a static string through the call chain: `resolveServerConfig()` → `main()` → `runAgentLoop()` → `confirmTool()`. To support token refresh, the auth header must be resolved dynamically at each API call rather than captured once at startup.

Two approaches to consider:

- **Getter function**: Replace the static `authHeader` string with a function `() => string` that `agent.js` calls before each `fetch()`. For API key auth this returns a constant; for Entra ID auth it calls `getAccessToken()` which already handles refresh-on-demand.
- **Background interval + mutable reference**: Keep the static string pattern but start a `setInterval` that periodically refreshes the token and updates the string in-place. Simpler call-site changes but introduces mutable shared state.

### Refresh Timing

The existing `getAccessToken()` already has a `TOKEN_EXPIRY_BUFFER_MS` (5 minutes) that triggers a refresh when the token is within 5 minutes of expiry. A background timer should call `getAccessToken()` on an interval shorter than the token lifetime but not so frequently that it hammers the token endpoint.

Consider:
- Interval based on token `expires_in` minus a buffer (e.g., refresh at the halfway point of the remaining lifetime)
- A fixed interval (e.g., every 10 minutes) that relies on `getAccessToken()` internal freshness check to skip unnecessary refreshes

### Cleanup

The background timer must be cleared when the REPL exits (on `exit` command, `rl.close()`, or process termination) to prevent the Node.js process from hanging.

### Error Handling

If a background refresh fails (network error, revoked refresh token), the behavior should be:
- Log a warning to the user that their session may expire soon
- Do not crash the REPL — let the analyst finish their current interaction
- The next API call will fail with a clear auth error message as it does today

## Key Files

- `cli/src/config.js` — `resolveServerConfig()` currently returns a static `authHeader` string
- `cli/src/auth-entra.js` — `getAccessToken()` handles token caching and refresh
- `cli/src/agent.js` — `runAgentLoop()` and `confirmTool()` consume the auth header for API calls
- `cli/src/index.js` — Main REPL loop, owns the readline interface and session lifecycle

## Open Questions

1. Should the background refresh log anything on success (e.g., a debug-only message), or be completely silent?
2. If the refresh token itself has been revoked server-side (e.g., admin forced sign-out), should the CLI prompt for re-login inline or just surface the error?
3. Should API key auth also get a periodic "health check" ping to verify the key hasn't been revoked, or is that out of scope?
