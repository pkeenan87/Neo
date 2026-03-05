import { createHash } from "crypto";
import { EventHubProducerClient } from "@azure/event-hubs";
import { env } from "./config";

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
//  PII hashing
// ─────────────────────────────────────────────────────────────

/**
 * One-way SHA-256 hash, truncated to 16 hex chars. Use for identifiers
 * (ownerId, aadObjectId) that must be correlatable across log entries
 * but must not appear as raw PII in the Event Hub sink.
 */
export function hashPii(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
//  Level filtering
// ─────────────────────────────────────────────────────────────

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let _resolvedLevel: LogLevel | null = null;

function getMinLevel(): LogLevel {
  if (_resolvedLevel) return _resolvedLevel;
  const raw = env.LOG_LEVEL?.toLowerCase();
  if (raw) {
    if (raw in LEVEL_PRIORITY) {
      _resolvedLevel = raw as LogLevel;
    } else {
      console.warn(
        `[logger] Unrecognized LOG_LEVEL "${env.LOG_LEVEL}" — valid values are: debug, info, warn, error. Defaulting.`
      );
      _resolvedLevel = env.MOCK_MODE ? "debug" : "info";
    }
  } else {
    _resolvedLevel = env.MOCK_MODE ? "debug" : "info";
  }
  return _resolvedLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
}

// ─────────────────────────────────────────────────────────────
//  Allowlist-based metadata redaction
// ─────────────────────────────────────────────────────────────

const SAFE_METADATA_FIELDS = new Set([
  "sessionId",
  "role",
  "ownerIdHash",
  "provider",
  "toolName",
  "toolId",
  "hostname",
  // SECURITY: "upn" is a user principal name (email address — PII).
  // Callers MUST hash the value with hashPii() before passing it as metadata.
  "upn",
  "platform",
  "severity",
  "status",
  "messageCount",
  "component",
  "errorMessage",
  "statusCode",
  "method",
  "action",
  "conversationId",
  "aadObjectIdHash",
  "matchCount",
  "messageLength",
  "mode",
  "label",
  "userIdHash",
]);

function sanitizeMetadata(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const safe: Record<string, unknown> = {};
  let hasKeys = false;
  for (const key of Object.keys(meta)) {
    if (SAFE_METADATA_FIELDS.has(key)) {
      safe[key] = meta[key];
      hasKeys = true;
    }
  }
  return hasKeys ? safe : undefined;
}

// ─────────────────────────────────────────────────────────────
//  Console sink
// ─────────────────────────────────────────────────────────────

function logToConsole(entry: LogEntry): void {
  // In production, only warn/error go to console
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY["warn"]) return;

  const ts = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
  const meta = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
  const line = `[${ts}] ${entry.level.toUpperCase()} [${entry.component}] ${entry.message}${meta}`;

  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

// ─────────────────────────────────────────────────────────────
//  Event Hub sink (lazy init, buffered)
// ─────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 50;

let _producer: EventHubProducerClient | null = null;
let _producerInitAttempted = false;
let _buffer: LogEntry[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _closing = false;
let _flushInProgress = false;

function getProducer(): EventHubProducerClient | null {
  if (_producerInitAttempted) return _producer;
  _producerInitAttempted = true;

  const connStr = env.EVENT_HUB_CONNECTION_STRING;
  const hubName = env.EVENT_HUB_NAME;

  if (!connStr || !hubName) {
    console.warn(
      "[logger] Event Hub logging disabled — EVENT_HUB_CONNECTION_STRING or EVENT_HUB_NAME not set."
    );
    return null;
  }

  _producer = new EventHubProducerClient(connStr, hubName);

  _flushTimer = setInterval(() => {
    void flushBuffer();
  }, FLUSH_INTERVAL_MS);

  return _producer;
}

async function flushBuffer(): Promise<void> {
  if (_flushInProgress || _buffer.length === 0) return;
  _flushInProgress = true;

  const producer = _producer;
  if (!producer) {
    _buffer = [];
    _flushInProgress = false;
    return;
  }

  const entries = _buffer;
  _buffer = [];

  try {
    const pending = [...entries];
    while (pending.length > 0) {
      const batch = await producer.createBatch();
      while (pending.length > 0) {
        const added = batch.tryAdd({ body: pending[0] });
        if (!added) break;
        pending.shift();
      }
      if (batch.count === 0) {
        // Single entry too large for a batch — discard it
        console.error("[logger] Single log entry exceeds Event Hub batch size; discarding.");
        pending.shift();
        continue;
      }
      await producer.sendBatch(batch);
    }
  } catch (err) {
    console.error(
      "[logger] Failed to send log batch to Event Hub:",
      (err as Error).message
    );
    // Discard remaining entries to prevent unbounded growth
  } finally {
    _flushInProgress = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  Core log function
// ─────────────────────────────────────────────────────────────

function log(
  level: LogLevel,
  message: string,
  component: string,
  metadata?: Record<string, unknown>
): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    metadata: sanitizeMetadata(metadata),
  };

  logToConsole(entry);

  // Buffer for Event Hub
  const producer = getProducer();
  if (producer) {
    _buffer.push(entry);
    if (_buffer.length >= FLUSH_THRESHOLD) {
      void flushBuffer();
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

export const logger = {
  debug(message: string, component: string, metadata?: Record<string, unknown>): void {
    log("debug", message, component, metadata);
  },
  info(message: string, component: string, metadata?: Record<string, unknown>): void {
    log("info", message, component, metadata);
  },
  warn(message: string, component: string, metadata?: Record<string, unknown>): void {
    log("warn", message, component, metadata);
  },
  error(message: string, component: string, metadata?: Record<string, unknown>): void {
    log("error", message, component, metadata);
  },
};

export async function flushLogs(): Promise<void> {
  await flushBuffer();
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  if (_producer) {
    try {
      await _producer.close();
    } catch (err) {
      console.error("[logger] Error closing Event Hub producer:", (err as Error).message);
    } finally {
      _producer = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────────────────────

function shutdown(): void {
  if (_closing) return;
  _closing = true;
  void flushLogs().catch(() => {});
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
