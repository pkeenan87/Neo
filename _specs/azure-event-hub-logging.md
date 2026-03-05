# Azure Event Hub Logging

> Structured application logging for both the CLI and web projects, shipped to Azure Event Hubs for centralized ingestion into Sentinel, Splunk, or any downstream SIEM.

## Problem

The Neo application has no structured logging. `console.log` and `console.warn` calls are scattered throughout both the CLI and web projects, writing unstructured text to stdout/stderr. There is no way to aggregate logs across instances, correlate events across the agent loop, search historical activity, or alert on errors. For a security operations tool that executes destructive actions (password resets, machine isolation), this lack of audit trail is a significant operational and compliance gap.

## Goals

- Introduce a lightweight structured logging module usable by both the CLI and web projects - just the web project for now
- Every log entry includes a consistent schema: timestamp, level, component, message, and structured metadata
- All log output is sent to an Azure Event Hub in near-real-time for centralized collection
- Provide a PowerShell provisioning script that creates the Event Hub Namespace, Event Hub, and authorization rules
- Log key agent lifecycle events: tool calls, destructive action confirmations/cancellations, session creation, authentication outcomes, and errors
- Retain local console output in development (controlled by log level / environment)

## Non-Goals

- Building a log viewer UI inside the Neo web application
- Implementing log-based alerting rules (that belongs in the downstream SIEM)
- Replacing the existing `console.warn`/`console.error` calls in third-party dependencies
- Implementing log rotation or local file-based logging — Event Hub is the sole durable sink
- Adding distributed tracing (correlation IDs, spans) — that is a potential future enhancement
- Logging the full content of LLM prompts or responses (too large, and may contain sensitive data)

## User Stories

1. **As a SOC manager**, I can query the Event Hub (or downstream SIEM) for all destructive actions taken by the Neo agent in the past 24 hours, so I have a complete audit trail of containment actions.
2. **As a platform admin**, I can run a single PowerShell script to provision the Azure Event Hub infrastructure needed for log collection, so I don't have to configure it manually in the Azure Portal.
3. **As a developer**, I can import a logger and call `logger.info("message", { key: value })` from anywhere in the CLI or web codebase, and the log is automatically formatted and shipped to Event Hub.
4. **As a developer**, I still see log output in my local terminal during development, so I don't lose visibility when running in `MOCK_MODE=true`.
5. **As a platform admin**, I can see authentication failures and rate limit events in the centralized logs, so I can detect abuse or misconfiguration.
6. **As a SOC analyst using the Teams bot**, my conversation-triggered tool calls appear in the centralized logs with my identity attached, so actions are attributable.

## Design Considerations

### Logger Module Location and Sharing

Just the web (`web/lib/`) projects need access to the logger. 

### Log Schema

Every log entry should be a JSON object with at least:

- `timestamp` — ISO 8601
- `level` — `debug`, `info`, `warn`, `error`
- `component` — which part of the system emitted the log (e.g., `agent`, `auth`, `executor`, `teams-bot`, `session`)
- `message` — human-readable description
- `metadata` — arbitrary structured data (tool name, session ID, user identity, error details)

Sensitive fields (passwords, tokens, API keys) must never appear in metadata. The logger should strip or redact known sensitive field names before serialization.

### Event Hub Integration

The Azure Event Hubs SDK (`@azure/event-hubs`) provides an `EventHubProducerClient` that batches and sends events. Key design decisions:

- **Batching**: Buffer log events and flush on an interval (e.g., every 5 seconds) or when the batch reaches a size threshold, to avoid a network call per log line
- **Connection string**: Stored in a new `EVENT_HUB_CONNECTION_STRING` environment variable
- **Graceful degradation**: If the connection string is not set or the Event Hub is unreachable, log a warning once and fall back to console-only output — the application must not crash because logging is unavailable
- **Shutdown**: Flush pending events on process exit (SIGTERM, SIGINT) to avoid losing the tail of the log

### What to Log

Instrument the following events at minimum:

- **Agent loop**: session created, agent loop started, tool called (name + sanitized input), loop completed
- **Destructive actions**: confirmation requested, user confirmed, user cancelled (include tool name, session ID, user identity)
- **Authentication**: successful login, failed login, token refresh, role resolved (include provider, identity, role)
- **Errors**: unhandled exceptions, tool execution failures, API call failures (include error message, stack trace)
- **Rate limiting**: session rate-limited (include session ID, message count)
- **Teams bot**: message received, card submit received, identity verification failed

### Provisioning Script

A new PowerShell script (`scripts/provision-event-hub.ps1`) should create:

- **Event Hub Namespace** — the container for Event Hubs, with a configurable SKU (Basic for dev, Standard for production)
- **Event Hub** — the actual hub instance within the namespace, with configurable partition count and message retention
- **Shared Access Policy** — a `Send`-only authorization rule for the application to use (least privilege — the app should not be able to read or manage the hub)

The script should follow the same patterns as the existing `scripts/provision-azure.ps1`: parameterized, idempotent, validates prerequisites (Azure CLI installed, logged in, correct subscription), and outputs the connection string at the end for the admin to add to `.env`.

### Environment Variables

New variables needed:

- `EVENT_HUB_CONNECTION_STRING` — the connection string for the Event Hub Namespace with the Send policy
- `EVENT_HUB_NAME` — the name of the specific Event Hub within the namespace
- `LOG_LEVEL` — minimum level to emit (`debug`, `info`, `warn`, `error`); defaults to `info` in production, `debug` in development

### Console Output in Development

When `MOCK_MODE=true` or `LOG_LEVEL=debug`, the logger should also write to stdout using colored, human-readable formatting (similar to how the CLI currently uses chalk). When Event Hub credentials are not configured, console output is the only sink and no error should be raised.

## Key Files

- `web/lib/logger.ts` — Web logging module with Event Hub and console sinks
- `scripts/provision-event-hub.ps1` — PowerShell script to create Event Hub Namespace, Hub, and auth rules
- `web/lib/config.ts` — Add new env vars to `EnvConfig` and `env` object
- `web/lib/types.ts` — Extend `EnvConfig` interface with new env vars
- `.env.example` — Document new env vars

## Open Questions

1. Should the CLI and web logger modules be fully independent implementations (matching interface, separate code), or should a shared package be introduced at the repo root? Independent copies are simpler but risk drift over time. only do the web logger
2. What message retention period should the Event Hub default to? 1 day is the minimum (Basic SKU), 7 days is the Standard SKU default. Longer retention increases cost but allows replaying events if the downstream SIEM misses ingestion. 1 day
3. Should the provisioning script also create a Consumer Group for the downstream SIEM, or leave that to the SIEM setup? leave that to SIEM setup
4. Should the logger redact all values for keys matching patterns like `password`, `secret`, `token`, `key`, or should it use an explicit allowlist of safe fields? allowlist of safe fields
5. What partition count should the Event Hub default to? 2 is sufficient for the expected log volume, but higher counts allow more parallel consumers downstream. 2
