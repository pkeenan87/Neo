import readline from "readline";
import chalk from "chalk";
import os from "os";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { resolveServerConfig, parseFlag, hasFlag, validateServerUrl } from "./config.js";
import { runAgentLoop, confirmTool } from "./agent.js";
import { fetchConversations, fetchSkills } from "./server-client.js";
import { checkForUpdate, runUpdate } from "./updater.js";
import { login, logout, status, getAccessToken } from "./auth-entra.js";
import { readConfig, writeConfig } from "./config-store.js";
import { formatForTerminal } from "./format-terminal.js";

const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes — must be shorter than the 5-minute buffer in getAccessToken()


// ─────────────────────────────────────────────────────────────
//  Terminal helpers
// ─────────────────────────────────────────────────────────────

// Destructive tool names — used only for display styling.
// Enforcement happens on the server.
const DESTRUCTIVE_TOOLS = new Set([
  "reset_user_password",
  "isolate_machine",
  "unisolate_machine"
]);

const TOOL_COLORS = {
  run_sentinel_kql:       chalk.cyan,
  get_sentinel_incidents: chalk.cyan,
  get_xdr_alert:          chalk.yellow,
  search_xdr_by_host:     chalk.yellow,
  get_machine_isolation_status: chalk.yellow,
  search_user_messages:   chalk.blue,
  get_user_info:          chalk.blue,
  reset_user_password:    chalk.red.bold,
  dismiss_user_risk:      chalk.red.bold,
  list_ca_policies:       chalk.blue,
  get_ca_policy:          chalk.blue,
  list_named_locations:   chalk.blue,
  isolate_machine:        chalk.red.bold,
  unisolate_machine:      chalk.magenta.bold,
  report_message_as_phishing: chalk.red.bold,
  list_threatlocker_approvals: chalk.green,
  get_threatlocker_approval:  chalk.green,
  approve_threatlocker_request: chalk.red.bold,
  deny_threatlocker_request:   chalk.red.bold,
  search_threatlocker_computers: chalk.green,
  get_threatlocker_computer:   chalk.green,
  set_maintenance_mode:        chalk.red.bold,
  schedule_bulk_maintenance:   chalk.red.bold,
  enable_secured_mode:         chalk.red.bold,
  block_indicator:             chalk.red.bold,
  import_indicators:           chalk.red.bold,
  list_indicators:             chalk.yellow,
  delete_indicator:            chalk.red.bold,
  get_vendor_risk:             chalk.green,
  list_vendors:                chalk.green,
  get_vendor_activity:         chalk.green,
  list_vendor_cases:           chalk.green,
  get_vendor_case:             chalk.green,
  get_employee_profile:        chalk.green,
  get_employee_login_history:  chalk.green,
  list_abnormal_threats:       chalk.green,
  get_abnormal_threat:         chalk.green,
  list_ato_cases:              chalk.green,
  get_ato_case:                chalk.green,
  action_ato_case:             chalk.red.bold,
  list_appomni_services:       chalk.magenta,
  get_appomni_service:         chalk.magenta,
  list_appomni_findings:       chalk.magenta,
  get_appomni_finding:         chalk.magenta,
  list_appomni_finding_occurrences: chalk.magenta,
  list_appomni_insights:       chalk.magenta,
  list_appomni_policy_issues:  chalk.magenta,
  list_appomni_identities:     chalk.magenta,
  get_appomni_identity:        chalk.magenta,
  list_appomni_discovered_apps: chalk.magenta,
  get_appomni_audit_logs:      chalk.magenta,
  action_appomni_finding:      chalk.red.bold
};

const username = os.userInfo().username;

function formatTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const MATRIX_QUOTES = [
  `Wake up, ${username}...`,
  "The Matrix has you...",
  "Follow the white rabbit.",
  "There is no spoon.",
  "Everything that has a beginning has an end.",
  "We know KQL.",
  "Free your mind.",
  "No one can be told what the logs contain.",
  "I know kung fu.  →  Show me the alerts.",
  "You take the blue pill, the incident closes.",
  "Ignorance is bliss. Not on our watch."
];

function printBanner() {
  const quote = MATRIX_QUOTES[Math.floor(Math.random() * MATRIX_QUOTES.length)];
  console.log(chalk.bold.green(`
    ███╗   ██╗███████╗ ██████╗
    ████╗  ██║██╔════╝██╔═══██╗
    ██╔██╗ ██║█████╗  ██║   ██║
    ██║╚██╗██║██╔══╝  ██║   ██║
    ██║ ╚████║███████╗╚██████╔╝
    ╚═╝  ╚═══╝╚══════╝ ╚═════╝
  `));
  console.log(chalk.green("    [ S E C U R I T Y  A G E N T  v2.0 ]"));
  console.log(chalk.gray(`    [ ${quote.padEnd(38)} ]`));
  console.log(chalk.gray("\n    exit \u2014 quit  |  clear \u2014 reset context  |  history \u2014 list sessions  |  resume N \u2014 continue one\n"));
}

function printToolCall(name, input) {
  clearThinking();
  const color = TOOL_COLORS[name] || chalk.white;
  const prefix = DESTRUCTIVE_TOOLS.has(name) ? "[DESTRUCTIVE] " : "[tool] ";

  console.log(color(`\n${prefix}${name}`));

  // Print the most relevant input fields concisely
  const highlights = {};
  if (input.description) highlights.description = input.description;
  if (input.upn) highlights.upn = input.upn;
  if (input.hostname) highlights.hostname = input.hostname;
  if (input.platform) highlights.platform = input.platform;
  if (input.justification) highlights.justification = input.justification;
  if (input.query && !input.description) highlights.query = input.query.substring(0, 80) + "...";

  for (const [k, v] of Object.entries(highlights)) {
    console.log(color(`   ${k}: ${v}`));
  }
}

function createTerminalMarkdown() {
  return new Marked(
    markedTerminal({
      width: process.stdout.columns || 80,
      reflowText: true,
      showSectionPrefix: false,
      tab: 2,
      emoji: false,
    })
  );
}

function printResponse(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const formatted = formatForTerminal(normalized);
  const md = createTerminalMarkdown();
  let rendered = md.parse(formatted);

  // Safety net: convert any remaining raw markdown bold/italic markers
  // that marked-terminal didn't handle (edge cases in list items, etc.)
  rendered = rendered.replace(/\*\*(.+?)\*\*/gs, (_, t) => chalk.bold(t));
  rendered = rendered.replace(/\*(.+?)\*/gs, (_, t) => chalk.underline(t));

  console.log("\n" + rendered);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerInterval = null;
let spinnerFrame = 0;

function printThinking() {
  clearThinking();
  process.stdout.write("\n");
  spinnerFrame = 0;
  spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    process.stdout.write(chalk.gray(`\r  ${frame} Thinking...`));
    spinnerFrame++;
  }, 80);
}

function clearThinking() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write("\r\x1b[2K");
  }
}

// ─────────────────────────────────────────────────────────────
//  Confirmation prompt for destructive tools
// ─────────────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS = {
  reset_user_password: (input) => `Reset password for ${chalk.bold(input.upn)}${input.revoke_sessions !== false ? " + revoke all sessions" : ""}`,
  dismiss_user_risk:   (input) => `Dismiss risk for ${chalk.bold(input.upn)} in Entra ID`,
  isolate_machine:     (input) => `Network-isolate ${chalk.bold(input.hostname)} on ${input.platform} (${input.isolation_type || "Full"})`,
  unisolate_machine:   (input) => `Release ${chalk.bold(input.hostname)} from network isolation`,
  report_message_as_phishing: (input) => `Report message as ${chalk.bold(input.report_type || "phishing")} in ${chalk.bold(input.upn)}'s mailbox`,
  approve_threatlocker_request: (input) => `Approve ThreatLocker request ${chalk.bold(input.approval_request_id)} (policy: ${input.policy_level || "computer"})`,
  deny_threatlocker_request:    (input) => `Deny ThreatLocker request ${chalk.bold(input.approval_request_id)}`,
  block_indicator:              (input) => `Block ${chalk.bold(input.indicator_type)} indicator: ${chalk.bold(input.value)}`,
  import_indicators:            (input) => `Import ${chalk.bold(String(input.indicators?.length ?? 0))} indicators into Defender`,
  delete_indicator:             (input) => `Delete Defender indicator #${chalk.bold(String(input.indicator_id))} — ${input.justification || "no reason given"}`,
  action_ato_case:              (input) => `Mark ATO case ${chalk.bold(input.case_id)} as ${chalk.bold(input.action)}`,
  set_maintenance_mode:         (input) => `Set ${chalk.bold(input.computer_id)} to ${chalk.bold(input.mode)} mode`,
  schedule_bulk_maintenance:    (input) => `Schedule ${chalk.bold(input.mode)} for ${chalk.bold(String(input.computers?.length ?? 0))} computers`,
  enable_secured_mode:          (input) => `Enable secured mode on ${chalk.bold(String(input.computers?.length ?? 0))} computers`,
  action_appomni_finding:       (input) => `${chalk.bold(input.action)} ${chalk.bold(String(input.occurrence_ids?.length ?? 0))} AppOmni finding occurrence(s)`
};

async function promptForConfirmation(rl, tool) {
  const descFn = TOOL_DESCRIPTIONS[tool.name];
  const actionDesc = descFn ? descFn(tool.input) : tool.name;

  console.log(chalk.red.bold("\n╔══════════ CONFIRMATION REQUIRED ══════════╗"));
  console.log(chalk.red(`   Action:       ${actionDesc}`));
  console.log(chalk.red(`   Justification: ${tool.input.justification}`));
  console.log(chalk.red.bold("╚════════════════════════════════════════════╝"));
  console.log(chalk.yellow("\nType 'yes' to confirm, anything else to cancel:"));

  return new Promise(resolve => {
    rl.question(chalk.yellow("  > "), answer => {
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  One-shot `neo prompt` — designed for agent-to-agent composition
//  (Claude Code, CI pipelines, other non-interactive callers).
//
//  Output discipline:
//    stdout — final assistant text (plain) OR NDJSON stream (--json).
//    stderr — progress + errors (tool calls, status, diagnostics).
//    exit   — 0 ok, 1 agent error, 2 auth error, 3 server/network error.
//
//  Stateless by default: each call starts a fresh session unless the
//  caller passes --session <id>. --session-out prints the minted id to
//  stderr after completion so callers can chain follow-ups.
//
//  Deliberately skips banner, update-check, token-refresh interval,
//  and readline — nothing that would leak into a piped pipeline.
// ─────────────────────────────────────────────────────────────

// Cap stdin at 1 MB — the agent has its own context-size limits, and
// anything over this is almost certainly a mistake (or a compromised
// upstream). Also prevents an OOM on the CLI host under `neo prompt
// - < /dev/urandom`-style abuse. Beyond the cap we destroy the stream
// and reject rather than letting the process grow unbounded.
const PROMPT_STDIN_MAX_BYTES = 1024 * 1024;

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    let rejected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (rejected) return;
      buf += chunk;
      if (Buffer.byteLength(buf, "utf8") > PROMPT_STDIN_MAX_BYTES) {
        rejected = true;
        process.stdin.destroy();
        reject(new Error(`stdin exceeds ${PROMPT_STDIN_MAX_BYTES} byte limit`));
      }
    });
    process.stdin.on("end", () => {
      if (!rejected) resolve(buf.trim());
    });
    process.stdin.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

// Flag vocabulary for the `prompt` subcommand. Used by the argv scan
// below to identify which tokens are flags vs. the positional message.
const PROMPT_KNOWN_FLAGS = new Set(["--json", "--session-out"]);
const PROMPT_VALUE_FLAGS = new Set(["--session", "--server", "--api-key"]);

/**
 * Scan `process.argv` starting after `neo prompt` for the first token
 * that isn't a known flag name or the value following a value-flag.
 * Returns `{ message }` with the message string, `{ unknownFlag }`
 * with the offending token when a `--`-prefixed token isn't in our
 * flag vocabulary (so the caller can surface a clear error rather
 * than silently sending "--debug" to the agent as a prompt), or
 * `{}` when no message was found.
 *
 * Supports both `--flag value` and `--flag=value` forms — the `=` form
 * is a single token and never consumes the next one. A bare `-` is the
 * stdin marker and passes through as the message.
 */
function extractPromptMessage() {
  let i = 3;
  while (i < process.argv.length) {
    const tok = process.argv[i];
    if (PROMPT_KNOWN_FLAGS.has(tok)) {
      i += 1;
      continue;
    }
    // `--flag=value` is a single token — treat as known if the prefix
    // matches any known flag.
    const eqIdx = tok.indexOf("=");
    if (eqIdx > 0 && tok.startsWith("--")) {
      const name = tok.slice(0, eqIdx);
      if (PROMPT_KNOWN_FLAGS.has(name) || PROMPT_VALUE_FLAGS.has(name)) {
        i += 1;
        continue;
      }
      return { unknownFlag: name };
    }
    if (PROMPT_VALUE_FLAGS.has(tok)) {
      i += 2;           // skip flag + its value
      continue;
    }
    // Any other `--`-prefixed token isn't in our vocabulary. Reject
    // rather than silently forwarding it as the message — otherwise
    // `neo prompt --debug "hi"` would send "--debug" to the agent as
    // the prompt text, which is almost certainly not what the caller
    // meant. The bare `-` stdin marker is NOT `--`-prefixed and
    // passes through.
    if (tok.startsWith("--")) {
      return { unknownFlag: tok };
    }
    return { message: tok };
  }
  return {};
}

async function handlePromptCommand() {
  const jsonMode = hasFlag("--json");
  const sessionOut = hasFlag("--session-out");
  const sessionId = parseFlag("--session");

  // Warn when --api-key appears on the argv in prompt mode. The env
  // var form is always preferred for non-interactive callers because
  // argv is visible in `ps aux` and often captured by CI / container
  // audit logs. Emitting a single stderr line keeps the warning
  // non-fatal while making the exposure visible.
  if (hasFlag("--api-key")) {
    process.stderr.write(
      "neo prompt: warning: --api-key is visible in the process table; " +
        "prefer the NEO_API_KEY env var for non-interactive callers.\n",
    );
  }

  // Scan argv for the message — position-independent so
  // `neo prompt --json "msg"` and `neo prompt "msg" --json` both work.
  const extracted = extractPromptMessage();

  if (extracted.unknownFlag) {
    process.stderr.write(
      `neo prompt: unknown flag "${extracted.unknownFlag}"\n` +
        `Known flags: --json, --session-out, --session <id>, --server <url>, --api-key <key>\n`,
    );
    process.exit(2);
  }

  let message;
  const rawMessage = extracted.message;
  if (!rawMessage) {
    process.stderr.write("Usage: neo prompt <message> [--session <id>] [--json] [--session-out]\n");
    process.stderr.write("       neo prompt - < file.txt      # read message from stdin\n");
    process.exit(2);
  }
  if (rawMessage === "-") {
    try {
      message = await readStdin();
    } catch (err) {
      process.stderr.write(`neo prompt: ${err.message}\n`);
      process.exit(2);
    }
    if (!message) {
      process.stderr.write("neo prompt: no input on stdin\n");
      process.exit(2);
    }
  } else {
    message = rawMessage.trim();
    if (!message) {
      process.stderr.write("neo prompt: message cannot be empty\n");
      process.exit(2);
    }
  }

  // Defensive catch: resolveServerConfig calls process.exit(1) on its
  // own failure paths (bad URL, Entra token failure, no auth
  // configured), so this catch only handles *unexpected* throws.
  // Initial auth failures therefore exit with code 1, not 2 — the
  // exit(2) below is reserved for throws that reach this level.
  let serverUrl, getAuthHeader;
  try {
    ({ serverUrl, getAuthHeader } = await resolveServerConfig());
  } catch (err) {
    process.stderr.write(`neo prompt: auth error: ${err.message}\n`);
    process.exit(2);
  }

  // Build callbacks. In plain mode, tool calls + thinking are
  // informational on stderr and the final text is returned by
  // streamMessage's terminal event. In --json mode, onRawEvent passes
  // every NDJSON event to stdout so agent-to-agent callers can parse
  // tool calls and results. NOTE: --json stdout carries tool inputs
  // (including PII like UPNs and KQL queries); see the security
  // subsection in docs/user-guide.md before redirecting stdout to a
  // log collector.
  const callbacks = jsonMode
    ? {
        onRawEvent: (event) => {
          process.stdout.write(JSON.stringify(event) + "\n");
        },
      }
    : {
        onToolCall: (name, input) => {
          const keys = Object.keys(input || {}).slice(0, 3).join(", ");
          process.stderr.write(`[tool] ${name}${keys ? ` (${keys})` : ""}\n`);
        },
        onSkillInvocation: (skill) => {
          process.stderr.write(`[skill] ${skill.name}\n`);
        },
      };

  let result;
  try {
    result = await runAgentLoop(message, sessionId, callbacks, getAuthHeader, serverUrl);
  } catch (err) {
    // Classify the error for exit-code selection. Auth errors here
    // mean the token refresh failed mid-request (vs the initial
    // resolve above); treat as exit 2 for consistency.
    //
    // Network errors come from Node's built-in fetch (undici) with
    // the shape `TypeError: fetch failed` and a nested `err.cause`
    // carrying the underlying errno code. Check both: the message
    // pattern catches the undici case even if the cause code is
    // absent, and the explicit code check is resilient if a future
    // wrapper re-throws as a plain Error instead of TypeError.
    const isAuth = err.code === "AUTH_ERROR" || /Unauthorized/i.test(err.message);
    const NETWORK_CAUSE_CODES = new Set([
      "ECONNREFUSED",
      "ENOTFOUND",
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ]);
    const causeCode = err.cause && typeof err.cause === "object" ? err.cause.code : undefined;
    const isServer =
      (err.name === "TypeError" && /fetch failed/i.test(err.message)) ||
      (causeCode && NETWORK_CAUSE_CODES.has(causeCode));
    const exitCode = isAuth ? 2 : isServer ? 3 : 1;
    process.stderr.write(`neo prompt: ${err.message}\n`);
    process.exit(exitCode);
  }

  if (result.type === "confirmation_required") {
    // A destructive tool needs human confirmation — one-shot mode
    // can't resolve that, so fail loud. The session stays live so an
    // interactive `neo --session <id>` invocation can resume it.
    if (!jsonMode) {
      const resumeHint = result.sessionId
        ? `Resume interactively with:  neo --session ${result.sessionId}\n`
        : `Session id unavailable — cannot resume automatically.\n`;
      process.stderr.write(
        `neo prompt: agent paused for confirmation of destructive tool "${result.tool.name}".\n` +
          resumeHint,
      );
    }
    if (sessionOut && result.sessionId) {
      process.stderr.write(`session: ${result.sessionId}\n`);
    }
    process.exit(1);
  }

  // result.type === "response"
  if (!jsonMode) {
    // Plain mode: write final assistant text, one trailing newline.
    process.stdout.write(result.text);
    if (!result.text.endsWith("\n")) process.stdout.write("\n");
  }
  if (sessionOut && result.sessionId) {
    process.stderr.write(`session: ${result.sessionId}\n`);
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
//  Auth sub-commands
// ─────────────────────────────────────────────────────────────

async function handleAuthCommand() {
  const sub = process.argv[3];

  if (!sub) {
    console.error("  Usage: neo auth <login|logout|status>\n");
    process.exit(1);
  }

  if (sub === "login") {
    const tenantId = parseFlag("--tenant-id");
    // Dev-only convenience — API keys passed via CLI flags are visible in the
    // process table (ps aux). Prefer NEO_API_KEY env var or interactive login.
    const apiKey = parseFlag("--api-key");

    if (apiKey) {
      // Persist API key auth
      const config = readConfig();
      config.authMethod = "api-key";
      config.apiKey = apiKey;
      writeConfig(config);
      console.log(chalk.green("\n  API key saved. You can now run: npm start\n"));
      return;
    }

    // Resolve and validate server URL for Entra ID discovery
    const config = readConfig();
    const serverUrl = validateServerUrl(
      parseFlag("--server") ||
      process.env.NEO_SERVER ||
      config.serverUrl
    );

    try {
      const { displayName } = await login({ tenantId, serverUrl });
      const isLocal = serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
      const serverHint = isLocal ? "" : ` --server ${serverUrl}`;
      console.log(chalk.green(`\n  Logged in as ${displayName}. You can now run: neo${serverHint}\n`));
      if (!isLocal) {
        console.log(chalk.gray(`  Tip: Run "neo config set server ${serverUrl}" to save this as your default.\n`));
      }
    } catch (err) {
      console.error(chalk.red(`\n  Login failed: ${err.message}\n`));
      console.error("  Usage:");
      console.error("    Entra ID: neo auth login [--tenant-id <id>]");
      console.error("    API key:  neo auth login --api-key <key>\n");
      console.error("  The CLI auto-discovers Entra ID config from the Neo server.");
      console.error("  Pass --tenant-id only if you need to override discovery.");
      console.error("  If discovery fails, verify the server is reachable:");
      console.error(`    Server: ${serverUrl}`);
      console.error("  Override with: --server <url> or NEO_SERVER env variable.\n");
      process.exit(1);
    }
    return;
  }

  if (sub === "logout") {
    logout();
    console.log(chalk.gray("\n  Credentials cleared.\n"));
    return;
  }

  if (sub === "status") {
    const config = readConfig();
    const serverUrl = process.env.NEO_SERVER || config.serverUrl;

    console.log(chalk.bold("\n  Neo CLI Status\n"));
    console.log(`  Server:      ${serverUrl}`);
    console.log(`  Auth method: ${config.authMethod || "not configured"}`);

    if (config.authMethod === "entra-id") {
      const s = status();
      console.log(`  Logged in:   ${s.loggedIn ? chalk.green("[yes]") : chalk.red("[no]")}`);
      if (s.username) console.log(`  User:        ${s.username}`);
      if (config.entraId?.tenantId) console.log(`  Tenant:      ${config.entraId.tenantId}`);
      if (s.expiresAt) {
        const remaining = Math.max(0, Math.round((s.expiresAt.getTime() - Date.now()) / 60000));
        console.log(`  Token:       ${remaining > 0 ? chalk.green(`[valid] ${remaining}m remaining`) : chalk.red("[expired]")}`);
      }
    } else if (config.authMethod === "api-key") {
      console.log(`  API key:     ${chalk.green("[ok] configured")}`);
    }

    if (process.env.NEO_API_KEY) {
      console.log(`  ${chalk.yellow("(NEO_API_KEY env var is set — overrides config file)")}`);
    }

    console.log();
    return;
  }

  console.error(chalk.red(`\n  Unknown auth command: "${sub}"`));
  console.error("  Usage: neo auth <login|logout|status>\n");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//  Config command
// ─────────────────────────────────────────────────────────────

function handleConfigCommand() {
  const action = process.argv[3]; // "set" or "get"
  const key = process.argv[4];    // "server"
  const value = process.argv[5];  // the URL

  if (action === "set" && key === "server" && value) {
    const url = validateServerUrl(value);
    const config = readConfig();
    config.serverUrl = url;
    writeConfig(config);
    console.log(chalk.green(`\n  Default server saved: ${url}\n`));
    return;
  }

  if (action === "get" && key === "server") {
    const config = readConfig();
    console.log(`\n  Server: ${config.serverUrl}\n`);
    return;
  }

  console.error(`
  Usage:
    neo config set server <url>   Save a default server URL
    neo config get server         Show the current default server URL
`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//  Main REPL loop
// ─────────────────────────────────────────────────────────────

async function main() {
  // Handle sub-commands before starting the REPL
  if (process.argv[2] === "auth") {
    await handleAuthCommand();
    return;
  }

  if (process.argv[2] === "config") {
    handleConfigCommand();
    return;
  }

  if (process.argv[2] === "update") {
    const { serverUrl, getAuthHeader } = await resolveServerConfig();
    await runUpdate(serverUrl, getAuthHeader);
    return;
  }

  if (process.argv[2] === "prompt") {
    await handlePromptCommand();
    return;
  }

  // Resolve server config (exits on failure)
  const { serverUrl, getAuthHeader, authMethod } = await resolveServerConfig();

  printBanner();
  console.log(chalk.gray(`    Connected to ${serverUrl}\n`));

  // ── Check for CLI updates (non-blocking) ────────────────
  try { await checkForUpdate(serverUrl, getAuthHeader); } catch { /* silent */ }

  // ── Background token refresh for Entra ID sessions ──────
  let refreshInterval = null;
  if (authMethod === "entra-id") {
    refreshInterval = setInterval(async () => {
      try {
        await getAccessToken();
        if (process.env.DEBUG) process.stderr.write("[debug] Background token refresh succeeded\n");
      } catch (err) {
        console.error(chalk.yellow(`\n  ⚠ Token refresh failed — session may expire soon.`));
        if (process.env.DEBUG) console.error(chalk.yellow(`    ${err.message}`));
        console.error(chalk.yellow(`    Run 'auth login' to re-authenticate.\n`));
      }
    }, REFRESH_INTERVAL_MS);
    refreshInterval.unref();
  }

  function cleanup() {
    if (refreshInterval) clearInterval(refreshInterval);
  }

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const rlQuestion = (prompt) =>
    new Promise(resolve => rl.question(prompt, resolve));

  // Honor `--session <id>` at REPL startup so a caller coming from
  // `neo prompt` (which exits with a resume hint when a destructive
  // tool needs confirmation) lands in a REPL bound to the paused
  // session and can approve or cancel. Falls through to a fresh
  // session when absent.
  let sessionId = parseFlag("--session") ?? null;
  if (sessionId) {
    console.log(chalk.gray(`    Resuming session ${sessionId}\n`));
  }
  let lastHistory = [];

  const callbacks = {
    onToolCall:  printToolCall,
    onThinking:  printThinking,
    onSkillInvocation: (skill) => {
      clearThinking();
      console.log(chalk.magenta(`\n[skill] ${skill.name}`));
    },
  };

  while (true) {
    const userInput = await rlQuestion(chalk.bold.green("\n🔐 You: "));

    if (!userInput.trim()) continue;

    if (userInput.trim().toLowerCase() === "exit") {
      console.log(chalk.gray("\nGoodbye.\n"));
      cleanup();
      rl.close();
      break;
    }

    if (userInput.trim().toLowerCase() === "clear") {
      sessionId = null;
      console.log(chalk.gray("  Conversation history cleared.\n"));
      continue;
    }

    if (userInput.trim().toLowerCase() === "history") {
      try {
        const conversations = await fetchConversations(serverUrl, getAuthHeader);
        lastHistory = conversations;
        if (conversations.length === 0) {
          console.log(chalk.gray("  No previous conversations found.\n"));
        } else {
          console.log(chalk.bold("\n  Recent Conversations:\n"));
          conversations.forEach((c, i) => {
            const title = c.title || "Untitled";
            const channel = c.channel || "web";
            const msgs = c.messageCount || 0;
            const date = c.updatedAt ? new Date(c.updatedAt) : new Date(c.createdAt);
            const ago = formatTimeAgo(date);
            const num = chalk.bold(`  ${String(i + 1).padStart(2)}.`);
            console.log(`${num} ${title}  |  ${chalk.gray(`[${channel}] ${msgs} msgs, ${ago}`)}`);
          });
          console.log(chalk.gray("\n  Use 'resume N' to continue a conversation.\n"));
        }
      } catch (err) {
        console.error(chalk.red(`\n  Error fetching history: ${err.message}\n`));
      }
      continue;
    }

    if (userInput.trim().toLowerCase() === "/skills") {
      try {
        const skills = await fetchSkills(serverUrl, getAuthHeader);
        if (skills.length === 0) {
          console.log(chalk.gray("  No skills configured.\n"));
        } else {
          console.log(chalk.bold("\n  Available Skills:\n"));
          skills.forEach((s) => {
            const params = s.parameters?.length > 0
              ? chalk.gray(` ${s.parameters.map(p => `<${p}>`).join(" ")}`)
              : "";
            console.log(`  ${chalk.green(`/${s.id}`)}${params}  ${chalk.gray("—")} ${s.name}`);
            if (s.description) {
              console.log(chalk.gray(`    ${s.description.slice(0, 80)}${s.description.length > 80 ? "..." : ""}`));
            }
          });
          console.log();
        }
      } catch (err) {
        console.error(chalk.red(`\n  Error fetching skills: ${err.message}\n`));
      }
      continue;
    }

    const resumeMatch = userInput.trim().match(/^resume\s+(\d+)$/i);
    if (resumeMatch) {
      const idx = parseInt(resumeMatch[1], 10) - 1;
      if (lastHistory.length === 0) {
        console.error(chalk.yellow("  Warning: Run 'history' first to load the conversation list.\n"));
      } else if (idx < 0 || idx >= lastHistory.length) {
        console.error(chalk.yellow(`  Error: Invalid index. Choose 1\u2013${lastHistory.length}.\n`));
      } else {
        const conv = lastHistory[idx];
        sessionId = conv.id;
        const title = conv.title || "Untitled";
        console.log(chalk.green(`  Resumed conversation: ${title}\n`));
      }
      continue;
    }

    try {
      let result = await runAgentLoop(userInput, sessionId, callbacks, getAuthHeader, serverUrl);

      // Update sessionId from server response
      if (result.sessionId) sessionId = result.sessionId;

      // ── Confirmation loop — there may be multiple destructive tools ──
      while (result.type === "confirmation_required") {
        if (!sessionId) {
          console.error(chalk.red("\n  Error: no session ID received from server — cannot confirm action.\n"));
          break;
        }

        const confirmed = await promptForConfirmation(rl, result.tool);

        if (confirmed) {
          console.log(chalk.yellow(`  [CONFIRMED] ${result.tool.name} — executing`));
        } else {
          console.log(chalk.gray("  Action cancelled.\n"));
        }

        result = await confirmTool(
          sessionId,
          result.tool,
          confirmed,
          callbacks,
          getAuthHeader,
          serverUrl
        );

        if (result.sessionId) sessionId = result.sessionId;
      }

      // Final response
      if (result.type === "response") {
        clearThinking();
        console.log(chalk.bold.green("\n🤖 Agent:"));
        printResponse(result.text);
      }

    } catch (err) {
      clearThinking();
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
      if (err.code) {
        console.error(chalk.gray(`   Code: ${err.code}`));
      }
      if (process.env.DEBUG) console.error(err.stack);
    }
  }
}

main();
