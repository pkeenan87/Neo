import { createHash } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventHubProducerClient } from "@azure/event-hubs";
import { env } from "./config";
import type { LogIdentityContext, LogEventType } from "./types";

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  eventType: LogEventType;
  identity?: LogIdentityContext;
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
//  Request-scoped logging context (AsyncLocalStorage)
// ─────────────────────────────────────────────────────────────

const logContext = new AsyncLocalStorage<LogIdentityContext>();

/**
 * Run a function with a logging identity context. All log entries
 * emitted within `fn` will automatically include the identity envelope.
 */
export function setLogContext<T>(context: LogIdentityContext, fn: () => T): T {
  return logContext.run(context, fn);
}

export function getLogContext(): LogIdentityContext | undefined {
  return logContext.getStore();
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
  "filename",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "estimatedCostUsd",
  "model",
  "budgetRemaining",
  "budgetWarning",
  // Enhanced observability fields
  "userName",
  "channel",
  "toolCategory",
  "isDestructive",
  "durationMs",
  "turnNumber",
  "skillId",
  "skillName",
  "confirmed",
  "justification",
  "windowType",
  "budgetLimit",
  "currentUsage",
  "percentUsed",
  "eventType",
  "toolInput",
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
//  Event type routing
// ─────────────────────────────────────────────────────────────

const ANALYTICS_EVENT_TYPES = new Set<LogEventType>([
  "tool_execution",
  "token_usage",
  "skill_invocation",
  "session_started",
  "session_ended",
]);

function isAnalyticsEvent(eventType: LogEventType): boolean {
  return ANALYTICS_EVENT_TYPES.has(eventType);
}

// ─────────────────────────────────────────────────────────────
//  Console sink
// ─────────────────────────────────────────────────────────────

function logToConsole(entry: LogEntry): void {
  // In production, only warn/error go to console (operational events always log)
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && entry.eventType === "operational" && LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY["warn"]) return;

  const ts = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
  const meta = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
  const eventTag = entry.eventType !== "operational" ? ` [${entry.eventType}]` : "";
  const identityTag = entry.identity ? ` user=${entry.identity.userName}` : "";
  const line = `[${ts}] ${entry.level.toUpperCase()} [${entry.component}]${eventTag}${identityTag} ${entry.message}${meta}`;

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
//  Event Hub sinks (lazy init, buffered)
// ─────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 50;

// ── Primary (operational) Event Hub ──

let _producer: EventHubProducerClient | null = null;
let _producerInitAttempted = false;
let _buffer: LogEntry[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;

// ── Analytics Event Hub (optional) ──

let _analyticsProducer: EventHubProducerClient | null = null;
let _analyticsProducerInitAttempted = false;
let _analyticsBuffer: LogEntry[] = [];
let _analyticsFlushTimer: ReturnType<typeof setInterval> | null = null;

let _closing = false;
let _flushInProgress = false;
let _analyticsFlushInProgress = false;

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
    void flushBuffer(_buffer, _producer, "operational");
  }, FLUSH_INTERVAL_MS);

  return _producer;
}

function getAnalyticsProducer(): EventHubProducerClient | null {
  if (_analyticsProducerInitAttempted) return _analyticsProducer;
  _analyticsProducerInitAttempted = true;

  const connStr = env.EVENT_HUB_ANALYTICS_CONNECTION_STRING;
  const hubName = env.EVENT_HUB_ANALYTICS_NAME;

  if (!connStr || !hubName) {
    // Graceful fallback — analytics events go to the primary topic
    return null;
  }

  _analyticsProducer = new EventHubProducerClient(connStr, hubName);

  _analyticsFlushTimer = setInterval(() => {
    void flushBuffer(_analyticsBuffer, _analyticsProducer, "analytics");
  }, FLUSH_INTERVAL_MS);

  return _analyticsProducer;
}

async function flushBuffer(
  buffer: LogEntry[],
  producer: EventHubProducerClient | null,
  label: string,
): Promise<void> {
  const inProgress = label === "analytics" ? _analyticsFlushInProgress : _flushInProgress;
  if (inProgress || buffer.length === 0) return;

  if (label === "analytics") _analyticsFlushInProgress = true;
  else _flushInProgress = true;

  if (!producer) {
    buffer.length = 0;
    if (label === "analytics") _analyticsFlushInProgress = false;
    else _flushInProgress = false;
    return;
  }

  const entries = [...buffer];
  buffer.length = 0;

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
        console.error(`[logger] Single log entry exceeds Event Hub batch size (${label}); discarding.`);
        pending.shift();
        continue;
      }
      await producer.sendBatch(batch);
    }
  } catch (err) {
    console.error(
      `[logger] Failed to send log batch to Event Hub (${label}):`,
      (err as Error).message
    );
  } finally {
    if (label === "analytics") _analyticsFlushInProgress = false;
    else _flushInProgress = false;
  }
}

function bufferEntry(entry: LogEntry): void {
  const isAnalytics = isAnalyticsEvent(entry.eventType);

  // Try the analytics producer first for analytics events
  if (isAnalytics) {
    const analyticsProducer = getAnalyticsProducer();
    if (analyticsProducer) {
      _analyticsBuffer.push(entry);
      if (_analyticsBuffer.length >= FLUSH_THRESHOLD) {
        void flushBuffer(_analyticsBuffer, analyticsProducer, "analytics");
      }
      return;
    }
    // Fall through to primary if analytics hub not configured
  }

  // Route to primary (operational) Event Hub
  const producer = getProducer();
  if (producer) {
    _buffer.push(entry);
    if (_buffer.length >= FLUSH_THRESHOLD) {
      void flushBuffer(_buffer, producer, "operational");
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Core log function
// ─────────────────────────────────────────────────────────────

function log(
  level: LogLevel,
  message: string,
  component: string,
  metadata?: Record<string, unknown>,
  eventType: LogEventType = "operational",
): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    eventType,
    identity: logContext.getStore(),
    metadata: sanitizeMetadata(metadata),
  };

  logToConsole(entry);
  bufferEntry(entry);
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

  /**
   * Emit a structured event (tool_execution, token_usage, destructive_action, etc.).
   * Always buffered to Event Hub regardless of LOG_LEVEL.
   * Console output follows normal production filtering rules.
   * Routed to the analytics or operational Event Hub based on event type.
   */
  emitEvent(
    eventType: LogEventType,
    message: string,
    component: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      component,
      message,
      eventType,
      identity: logContext.getStore(),
      metadata: sanitizeMetadata(metadata),
    };

    logToConsole(entry);
    bufferEntry(entry);
  },
};

export async function flushLogs(): Promise<void> {
  await flushBuffer(_buffer, _producer, "operational");
  await flushBuffer(_analyticsBuffer, _analyticsProducer, "analytics");

  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  if (_analyticsFlushTimer) {
    clearInterval(_analyticsFlushTimer);
    _analyticsFlushTimer = null;
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
  if (_analyticsProducer) {
    try {
      await _analyticsProducer.close();
    } catch (err) {
      console.error("[logger] Error closing analytics Event Hub producer:", (err as Error).message);
    } finally {
      _analyticsProducer = null;
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
