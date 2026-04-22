import { AsyncLocalStorage } from "node:async_hooks";
import { NEO_CONVERSATION_STORE_MODE } from "./config";
import { logger } from "./logger";
import type { ConversationStoreMode } from "./types";

// ─────────────────────────────────────────────────────────────
//  Conversation-store mode resolver
//
//  Each request can run against one of four storage modes:
//    v1, v2, dual-read, dual-write
//
//  The effective mode is resolved per-request from (in priority order):
//    1. AsyncLocalStorage context set by `withStoreMode` (per-request
//       override applied by the route guard after validating the
//       X-Neo-Store-Mode admin header).
//    2. The NEO_CONVERSATION_STORE_MODE env var (deployment default).
//
//  The env var is read once at boot via config.ts; the per-request
//  context is read on every call so mode changes take effect without
//  restarting the server. See _plans/conversation-storage-split-blob-offload.md.
// ─────────────────────────────────────────────────────────────

const MODE_HEADER_NAME = "x-neo-store-mode";
const VALID_MODES: readonly ConversationStoreMode[] = [
  "v1",
  "v2",
  "dual-read",
  "dual-write",
];

const modeContext = new AsyncLocalStorage<ConversationStoreMode>();

/**
 * The effective storage mode for the current request. Called from every
 * conversation-store dispatch site. Cheap — one AsyncLocalStorage read.
 */
export function getActiveStoreMode(): ConversationStoreMode {
  return modeContext.getStore() ?? NEO_CONVERSATION_STORE_MODE;
}

/**
 * Run `fn` with a per-request store-mode override. Used by the route
 * guard after validating the X-Neo-Store-Mode header against admin role.
 */
export function withStoreMode<T>(mode: ConversationStoreMode, fn: () => Promise<T> | T): Promise<T> | T {
  return modeContext.run(mode, fn);
}

/**
 * Parse an incoming X-Neo-Store-Mode header value. Returns the mode if
 * valid, or `null` for missing/invalid values. Never throws — invalid
 * values log a warning and resolve to null so the request proceeds with
 * the env-var default rather than 4xxing.
 */
export function parseModeHeader(raw: string | null | undefined): ConversationStoreMode | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if ((VALID_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as ConversationStoreMode;
  }
  return null;
}

/**
 * Route-layer guard. Wraps a request handler in a per-request store-mode
 * context when the caller is an admin supplying the `X-Neo-Store-Mode`
 * header. Non-admin callers with the header are silently ignored (no
 * error) — a misconfigured proxy can't accidentally leak the override
 * path that way. Each admin override logs a
 * `conversation_store_mode_override` audit event.
 *
 *   - `request`: the Next.js Request or NextRequest (must expose `headers`).
 *   - `identity`: the resolved auth identity (must have a `role` field).
 *   - `fn`: the handler body.
 *
 * When no override applies, `fn` is called directly (no context wrap)
 * so a small perf optimization applies to the common request path.
 */
export function withStoreModeFromRequest<T>(
  request: { headers: Headers | { get(name: string): string | null } },
  identity: { role?: string; name?: string } | null,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  // Pull header in a way that's compatible with both standard Request
  // (Headers.get) and NextRequest (same interface).
  const rawHeader =
    typeof (request.headers as Headers).get === "function"
      ? (request.headers as Headers).get(MODE_HEADER_NAME)
      : null;
  if (!rawHeader) return fn();

  const mode = parseModeHeader(rawHeader);
  if (!mode) {
    logger.warn("Invalid X-Neo-Store-Mode header — ignoring", "conversation-store-mode", {
      rawHeader: rawHeader.slice(0, 64),
    });
    return fn();
  }

  const isAdmin = identity?.role === "admin";
  if (!isAdmin) {
    logger.warn(
      "X-Neo-Store-Mode header from non-admin caller — ignoring",
      "conversation-store-mode",
      { requestedMode: mode, callerName: identity?.name },
    );
    return fn();
  }

  logger.emitEvent(
    "conversation_store_mode_override",
    `Admin override active for this request: ${mode}`,
    "conversation-store-mode",
    { mode, callerName: identity?.name ?? "unknown" },
  );

  return modeContext.run(mode, fn);
}

/**
 * Test-only escape hatch — forces a mode inside a callback for unit
 * tests that don't go through a Request object. Equivalent to
 * withStoreMode but named for clarity when used in specs.
 */
export function __forceStoreModeForTest<T>(
  mode: ConversationStoreMode,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return modeContext.run(mode, fn);
}
