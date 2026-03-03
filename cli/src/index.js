import readline from "readline";
import chalk from "chalk";
import os from "os";
import { resolveServerConfig, parseFlag } from "./config.js";
import { runAgentLoop, confirmTool } from "./agent.js";
import { login, logout, status } from "./auth-entra.js";
import { readConfig, writeConfig } from "./config-store.js";


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
  get_user_info:          chalk.blue,
  reset_user_password:    chalk.red.bold,
  isolate_machine:        chalk.red.bold,
  unisolate_machine:      chalk.magenta.bold
};

const username = os.userInfo().username;

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
  console.log(chalk.gray("\n    'exit' to quit  |  'clear' to reset context\n"));
}

function printToolCall(name, input) {
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

function printResponse(text) {
  console.log("\n" + chalk.white(text));
}

function printThinking() {
  process.stdout.write(chalk.gray("\n⏳ Thinking...\r"));
}

// ─────────────────────────────────────────────────────────────
//  Confirmation prompt for destructive tools
// ─────────────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS = {
  reset_user_password: (input) => `Reset password for ${chalk.bold(input.upn)}${input.revoke_sessions !== false ? " + revoke all sessions" : ""}`,
  isolate_machine:     (input) => `Network-isolate ${chalk.bold(input.hostname)} on ${input.platform} (${input.isolation_type || "Full"})`,
  unisolate_machine:   (input) => `Release ${chalk.bold(input.hostname)} from network isolation`
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
    console.error("  Usage: node src/index.js auth <login|logout|status>\n");
    process.exit(1);
  }

  if (sub === "login") {
    const tenantId = parseFlag("--tenant-id");
    const clientId = parseFlag("--client-id");
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

    try {
      const { displayName } = await login({ tenantId, clientId });
      console.log(chalk.green(`\n  Logged in as ${displayName}. You can now run: npm start\n`));
    } catch (err) {
      console.error(chalk.red(`\n  Login failed: ${err.message}\n`));
      console.error("  Usage:");
      console.error("    Entra ID: node src/index.js auth login --tenant-id <id> --client-id <id>");
      console.error("    API key:  node src/index.js auth login --api-key <key>\n");
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
    const serverUrl = process.env.NEO_SERVER || config.serverUrl || "http://localhost:3000";

    console.log(chalk.bold("\n  Neo CLI Status\n"));
    console.log(`  Server:      ${serverUrl}`);
    console.log(`  Auth method: ${config.authMethod || "not configured"}`);

    if (config.authMethod === "entra-id") {
      const s = status();
      console.log(`  Logged in:   ${s.loggedIn ? chalk.green("[yes]") : chalk.red("[no]")}`);
      if (s.username) console.log(`  User:        ${s.username}`);
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
  console.error("  Usage: node src/index.js auth <login|logout|status>\n");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//  Main REPL loop
// ─────────────────────────────────────────────────────────────

async function main() {
  // Handle auth sub-commands before starting the REPL
  if (process.argv[2] === "auth") {
    await handleAuthCommand();
    return;
  }

  // Resolve server config (exits on failure)
  const { serverUrl, authHeader } = await resolveServerConfig();

  printBanner();
  console.log(chalk.gray(`    Connected to ${serverUrl}\n`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const rlQuestion = (prompt) =>
    new Promise(resolve => rl.question(prompt, resolve));

  let sessionId = null;

  const callbacks = {
    onToolCall:  printToolCall,
    onThinking:  printThinking,
  };

  while (true) {
    const userInput = await rlQuestion(chalk.bold.green("\n🔐 You: "));

    if (!userInput.trim()) continue;

    if (userInput.trim().toLowerCase() === "exit") {
      console.log(chalk.gray("\nGoodbye.\n"));
      rl.close();
      break;
    }

    if (userInput.trim().toLowerCase() === "clear") {
      sessionId = null;
      console.log(chalk.gray("  Conversation history cleared.\n"));
      continue;
    }

    try {
      let result = await runAgentLoop(userInput, sessionId, callbacks, authHeader, serverUrl);

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
          authHeader,
          serverUrl
        );

        if (result.sessionId) sessionId = result.sessionId;
      }

      // Final response
      if (result.type === "response") {
        process.stdout.write("                    \r"); // clear "Thinking..." line
        console.log(chalk.bold.green("\n🤖 Agent:"));
        printResponse(result.text);
      }

    } catch (err) {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
      if (err.code) {
        console.error(chalk.gray(`   Code: ${err.code}`));
      }
      if (process.env.DEBUG) console.error(err.stack);
    }
  }
}

main();
