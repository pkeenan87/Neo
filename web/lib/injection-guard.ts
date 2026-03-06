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
    // Scoped to tool results only — too many false positives on user input
    // (SHA256 hashes, GUIDs, machineIds all match the base64 charset).
    pattern: /[A-Za-z0-9+/]{20,}={0,2}/,
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

export function scanUserInput(
  message: string,
  context: { sessionId: string; userId: string; role: string }
): ScanResult {
  const result = scan(message, USER_INPUT_PATTERNS);

  if (result.flagged) {
    logger.warn("Prompt injection detected in user input", "injection-guard", {
      sessionId: context.sessionId,
      userIdHash: hashPii(context.userId),
      role: context.role,
      label: result.label,
      matchCount: result.matchCount,
      messageLength: message.length,
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

export function shouldBlock(result: ScanResult): boolean {
  if (GUARD_MODE !== "block") return false;
  return result.matchCount >= BLOCK_THRESHOLD;
}
