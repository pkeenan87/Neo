import readline from "readline";
import chalk from "chalk";
import os from "os";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { resolveServerConfig, parseFlag, validateServerUrl } from "./config.js";
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
  isolate_machine:        chalk.red.bold,
  unisolate_machine:      chalk.magenta.bold,
  report_message_as_phishing: chalk.red.bold,
  list_threatlocker_approvals: chalk.green,
  get_threatlocker_approval:  chalk.green,
  approve_threatlocker_request: chalk.red.bold,
  deny_threatlocker_request:   chalk.red.bold,
  block_indicator:             chalk.red.bold,
  import_indicators:           chalk.red.bold,
  list_indicators:             chalk.yellow,
  delete_indicator:            chalk.red.bold,
  get_vendor_risk:             chalk.green,
  list_vendors:                chalk.green,
  get_vendor_activity:         chalk.green,
  list_vendor_cases:           chalk.green,
  get_vendor_case:             chalk.green
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
  delete_indicator:             (input) => `Delete Defender indicator #${chalk.bold(String(input.indicator_id))} — ${input.justification || "no reason given"}`
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

  let sessionId = null;
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
