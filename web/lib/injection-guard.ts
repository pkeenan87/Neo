import { logger, hashPii } from "./logger";

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

type GuardMode = "monitor" | "block";

export interface ScanResult {
  flagged: boolean;
  label?: string;
  matchCount: number;
}

// ─────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────

const raw = process.env.INJECTION_GUARD_MODE?.toLowerCase();
const GUARD_MODE: GuardMode =
  raw === "monitor" || raw === "block" ? raw : "monitor";

// Require at least 2 pattern matches before rejecting in block mode.
// A single match is treated as a potential false positive (many patterns are
// heuristic). Two independent pattern matches on the same message indicate
// higher-confidence adversarial intent.
// Calibrate this value against real traffic before enabling block mode.
const BLOCK_THRESHOLD = 2;

// ─────────────────────────────────────────────────────────────
//  Pattern definitions
// ─────────────────────────────────────────────────────────────

interface PatternEntry {
  pattern: RegExp;
  label: string;
}

// IMPORTANT: Never add the `g` flag to patterns in USER_INPUT_PATTERNS or
// TOOL_RESULT_PATTERNS. These RegExp objects are module-level singletons
// shared across all requests. A `g` flag would make .test() stateful via
// lastIndex and produce incorrect results under concurrent load.
const USER_INPUT_PATTERNS: PatternEntry[] = [
  {
    pattern: /(?:ignore|disregard|forget)\s+(?:your|previous|prior|all)\s+instructions/i,
    label: "instruction_override",
  },
  {
    pattern: /you\s+are\s+now\s+(?!investigating|analyzing|reviewing)(?:an?\s+)?\w+/i,
    label: "persona_reassignment",
  },
  {
    pattern: /new\s+(?:system\s+)?prompt:/i,
    label: "system_prompt_injection",
  },
  {
    pattern: /\[SYSTEM\]|^SYSTEM:/im,
    label: "system_header_injection",
  },
  {
    pattern: /^(?:ASSISTANT|USER):/im,
    label: "role_header_injection",
  },
  {
    pattern: /I\s+am\s+an\s+admin|I\s+have\s+(?:elevated|admin|root|full)\s+(?:access|permissions|privileges)/i,
    label: "role_claim",
  },
  {
    pattern: /(?:CISO|security\s+director|management)\s+has\s+(?:authorized|approved|instructed)/i,
    label: "authority_claim",
  },
  {
    pattern: /(?:skip\s+the\s+(?:confirmation|gate|approval|review)|no\s+(?:confirmation|approval)\s+(?:needed|required)|bypass\s+the\s+(?:confirmation|security|gate|check))/i,
    label: "gate_bypass_attempt",
  },
  {
    pattern: /(?:DAN|developer|maintenance)\s+mode/i,
    label: "jailbreak_mode",
  },
  {
    pattern: /override\s+(?:safety|guardrail|restriction|policy|rule)/i,
    label: "guardrail_override",
  },
];

// TOOL_RESULT_PATTERNS extends USER_INPUT_PATTERNS by design: any prompt injection
// attempt that could appear in user input could also be injected into an external
// data source (e.g., a malicious alert description in Sentinel). Review both arrays
// together when adding or removing patterns.
const TOOL_RESULT_PATTERNS: PatternEntry[] = [
  ...USER_INPUT_PATTERNS,
  {
    pattern: /you\s+(?:now\s+have|have\s+been\s+granted)\s+(?:root|admin|elevated|sudo|full)/i,
    label: "privilege_grant",
  },
  {
    pattern: /do\s+not\s+(?:isolate|block|reset|alert|contain)/i,
    label: "containment_suppression",
  },
  {
    pattern: /you\s+are\s+(?:authorized|permitted|allowed)\s+to/i,
    label: "permission_grant_in_data",
  },
  {
    pattern: /\b(?:curl|wget|nc|ncat|python3?\s+-c)\s+/i,
    label: "exfiltration_attempt",
  },
  {
    // Scoped to tool results only — and tightened to require explicit
    // base64 padding (`=` or `==`) so SHA256 hashes, GUIDs, machine
    // IDs, and other hex/alphanumeric identifiers — all common in
    // legitimate Wiz / Sentinel / Defender responses — don't trip
    // the heuristic. True adversarial base64 payloads almost always
    // have padding when not perfectly aligned (most binary data).
    pattern: /[A-Za-z0-9+/]{20,}={1,2}/,
    label: "encoded_payload",
  },
];

// ─────────────────────────────────────────────────────────────
//  Internal scanner
// ─────────────────────────────────────────────────────────────

function scan(text: string, patterns: PatternEntry[]): ScanResult {
  let matchCount = 0;
  let firstLabel: string | undefined;

  for (const entry of patterns) {
    if (entry.pattern.test(text)) {
      matchCount++;
      if (!firstLabel) {
        firstLabel = entry.label;
      }
    }
  }

  return {
    flagged: matchCount > 0,
    label: firstLabel,
    matchCount,
  };
}

// ─────────────────────────────────────────────────────────────
//  Exported functions
// ─────────────────────────────────────────────────────────────

/**
 * Scan user input for prompt injection patterns.
 * Accepts plain strings or array content blocks (for multimodal messages).
 * Only text content is scanned — image and document blocks are skipped.
 */
export function scanUserInput(
  message: string | unknown[],
  context: { sessionId: string; userId: string; role: string }
): ScanResult {
  // Extract text from array content blocks, skip binary/image/document blocks
  let textToScan: string;
  if (typeof message === "string") {
    textToScan = message;
  } else if (Array.isArray(message)) {
    textToScan = message
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type: string }).type === "text"
      )
      .map((b) => b.text)
      .join("\n");
  } else {
    textToScan = "";
  }

  const result = scan(textToScan, USER_INPUT_PATTERNS);

  if (result.flagged) {
    logger.warn("Prompt injection detected in user input", "injection-guard", {
      sessionId: context.sessionId,
      userIdHash: hashPii(context.userId),
      role: context.role,
      label: result.label,
      matchCount: result.matchCount,
      messageLength: textToScan.length,
      mode: GUARD_MODE,
    });
  }

  return result;
}

export function wrapToolResult(
  toolName: string,
  result: unknown,
  context: { sessionId: string }
): string {
  const resultJson = JSON.stringify(result);
  const scanResult = scan(resultJson, TOOL_RESULT_PATTERNS);

  if (scanResult.flagged) {
    logger.warn("Prompt injection detected in tool result", "injection-guard", {
      sessionId: context.sessionId,
      toolName,
      label: scanResult.label,
      matchCount: scanResult.matchCount,
    });
  }

  return JSON.stringify(
    {
      _neo_trust_boundary: {
        source: "external_api",
        tool: toolName,
        injection_detected: scanResult.flagged,
      },
      data: result,
    },
    null,
    2
  );
}

/**
 * Scan + wrap content from an Anthropic `mcp_tool_result` content block.
 *
 * Anthropic's MCP connector executes tools server-side, then returns
 * `mcp_tool_use` and `mcp_tool_result` blocks inline in the assistant
 * response. The result content reaches Neo's history without ever
 * passing through {@link wrapToolResult} — which is the seam where
 * other tool results get injection-scanned. Without this helper, an
 * adversarial Wiz payload would be appended to history and re-sent to
 * the model on every subsequent turn.
 *
 * The MCP result content field accepts either a string OR an array of
 * `{ type: "text", text }` blocks per the SDK spec. We extract the
 * scannable text from both shapes, run the same TOOL_RESULT_PATTERNS
 * scan that local tool results get, and return a string envelope with
 * the trust-boundary marker so downstream consumers (the model on the
 * next turn, the context-manager, the persistence path) can tell this
 * came from an external MCP server.
 *
 * The returned string is intended to replace the original `content`
 * field of the mcp_tool_result block before history-persistence.
 */
export function wrapMcpToolResultContent(
  rawContent: string | unknown[] | undefined,
  context: {
    sessionId: string;
    serverName: string;
    toolName: string;
  }
): string {
  // The MCP-connector spec permits `content` to contain text,
  // resource, and image-style blocks; we extract scannable text from
  // every shape we know about and serialize any unfamiliar block
  // type so an injection-bearing payload buried in a non-text block
  // can't bypass the scanner just by living in `{type:"resource"}`
  // instead of `{type:"text"}`. JSON.stringify on the unknown block
  // is intentionally over-inclusive — false positives on a non-
  // injection payload are a logging nuisance; false negatives on an
  // injection payload reach the model unscanned.
  let textToScan = "";
  if (typeof rawContent === "string") {
    textToScan = rawContent;
  } else if (Array.isArray(rawContent)) {
    const parts: string[] = [];
    for (const b of rawContent) {
      if (typeof b !== "object" || b === null) continue;
      const block = b as {
        type?: unknown;
        text?: unknown;
        resource?: { text?: unknown };
      };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if (
        block.type === "resource" &&
        typeof block.resource?.text === "string"
      ) {
        parts.push(block.resource.text);
        continue;
      }
      // Unknown block shape (image, future MCP types) — scan its
      // serialized form so embedded text-bearing fields can't slip
      // through. This catches the case where a future MCP block
      // type carries injection-pattern text in some inner field
      // we don't recognize yet.
      try {
        parts.push(JSON.stringify(b));
      } catch {
        // Circular reference or otherwise unserializable — skip;
        // we already log the wrap event so the operator can audit.
      }
    }
    textToScan = parts.join("\n");
  }

  const scanResult = scan(textToScan, TOOL_RESULT_PATTERNS);

  if (scanResult.flagged) {
    logger.warn("Prompt injection detected in MCP tool result", "injection-guard", {
      sessionId: context.sessionId,
      mcpServer: context.serverName,
      toolName: context.toolName,
      label: scanResult.label,
      matchCount: scanResult.matchCount,
    });
  }

  return JSON.stringify(
    {
      _neo_trust_boundary: {
        source: "mcp_external",
        server: context.serverName,
        tool: context.toolName,
        injection_detected: scanResult.flagged,
      },
      data: rawContent ?? "",
    },
    null,
    2
  );
}

/**
 * Audit (warn-log only) the metadata of an Anthropic
 * `web_search_tool_result` block for injection-pattern matches in the
 * title + URL fields the model and operators can see.
 *
 * Why this no longer mutates content: the previous implementation
 * wrapped the content into a `_neo_trust_boundary` JSON-string
 * envelope, but Anthropic's API rejects string content on
 * `web_search_tool_result` blocks — the schema enforces
 * `Array<WebSearchResultBlock> | WebSearchToolResultError`. Sending
 * the envelope back on the next turn produced:
 *   `400: messages.5.content.0.web_search_tool_result.content.list[...]
 *    Input should be a valid array`
 * which broke every multi-turn web_search session in production. Block
 * type already identifies the source (`web_search_tool_result`), and
 * the system-prompt EXTERNAL ENRICHMENT section instructs the model to
 * treat web content as untrusted, so the structural label was never
 * load-bearing for safety — it was purely advisory metadata.
 *
 * What we scan: title + URL only. The `encrypted_content` blob is
 * opaque base64 ciphertext that Anthropic re-uses internally — passing
 * it through the scanner trips the `encoded_payload` pattern on every
 * search (100% false positives, noisy warn log) without telling us
 * anything actionable.
 *
 * Returns the scan result so the caller can decide whether to surface
 * the signal further (audit event etc.). Side effect: a warn log when
 * flagged.
 */
export function auditWebSearchToolResultMetadata(
  rawContent: unknown,
  context: { sessionId: string; toolUseId?: string },
): ScanResult {
  let textToScan = "";
  if (Array.isArray(rawContent)) {
    const parts: string[] = [];
    for (const b of rawContent) {
      if (typeof b !== "object" || b === null) continue;
      const block = b as { type?: unknown; url?: unknown; title?: unknown };
      if (block.type !== "web_search_result") continue;
      if (typeof block.title === "string") parts.push(block.title);
      if (typeof block.url === "string") parts.push(block.url);
    }
    textToScan = parts.join("\n");
  } else if (typeof rawContent === "object" && rawContent !== null) {
    // Error envelope — { type: "web_search_tool_result_error",
    // error_code: "..." }. Stringify to scan any error_code value.
    try {
      textToScan = JSON.stringify(rawContent);
    } catch {
      textToScan = "";
    }
  }

  const scanResult = scan(textToScan, TOOL_RESULT_PATTERNS);
  if (scanResult.flagged) {
    logger.warn(
      "Prompt injection detected in web search result metadata",
      "injection-guard",
      {
        sessionId: context.sessionId,
        ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}),
        label: scanResult.label,
        matchCount: scanResult.matchCount,
      },
    );
  }
  return scanResult;
}

/**
 * Async wrapper around {@link wrapToolResult} that, after injection
 * scanning + envelope wrapping, offloads oversized payloads to Azure
 * Blob Storage via the tool-result blob store (phase 3). Returns the
 * inline envelope string below the offload threshold or a stringified
 * envelope containing a BlobRefDescriptor when the payload was moved
 * to blob storage.
 *
 * The agent loop (phase 6) calls this at each tool_result persistence
 * site; non-offload callers (e.g. triage, which writes results into
 * its own short-lived response path) can keep using the sync
 * {@link wrapToolResult} directly without going async.
 *
 * NOTE: when offload happens, the returned string IS the full
 * persisted content of the tool_result block. The envelope still
 * carries _neo_trust_boundary so promoteOffloadedBlobsIn's trust
 * check recognizes this as a server-generated descriptor rather than
 * a doctored Cosmos document.
 */
export async function wrapAndMaybeOffloadToolResult(
  toolName: string,
  result: unknown,
  context: { sessionId: string; conversationId: string; mediaType?: string },
): Promise<string> {
  const wrapped = wrapToolResult(toolName, result, { sessionId: context.sessionId });

  // Lazy import so this module doesn't create a cycle through
  // conversation-store-v2 / tool-result-blob-store at module-load
  // time. The import is resolved once, then cached by the Node loader.
  const { maybeOffloadToolResult } = await import("./tool-result-blob-store");
  const outcome = await maybeOffloadToolResult(wrapped, {
    conversationId: context.conversationId,
    sourceTool: toolName,
    mediaType: context.mediaType,
  });

  if (typeof outcome === "string") {
    // Below threshold or storage not configured — pass-through.
    return outcome;
  }

  // Above threshold — outcome is a BlobRefDescriptor. Re-wrap it in
  // the injection-guard envelope so the v2 store's
  // promoteOffloadedBlobsIn (which checks for _neo_trust_boundary
  // before trusting the descriptor) will promote the staging blob.
  return JSON.stringify(
    {
      _neo_trust_boundary: {
        source: "tool_offload",
        tool: toolName,
        injection_detected: false,
      },
      data: outcome,
    },
    null,
    2,
  );
}

export function shouldBlock(result: ScanResult): boolean {
  if (GUARD_MODE !== "block") return false;
  return result.matchCount >= BLOCK_THRESHOLD;
}
