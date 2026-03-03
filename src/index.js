import readline from "readline";
import chalk from "chalk";
import os from "os";
import { validateConfig } from "./config.js";
import { runAgentLoop, resumeAfterConfirmation } from "./agent.js";
import { DESTRUCTIVE_TOOLS } from "./tools.js";


// ─────────────────────────────────────────────────────────────
//  Terminal helpers
// ─────────────────────────────────────────────────────────────

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
  console.log(chalk.green("    [ S E C U R I T Y  A G E N T  v1.0 ]"));
  console.log(chalk.gray(`    [ ${quote.padEnd(38)} ]`));
  console.log(chalk.gray("\n    'exit' to quit  |  'clear' to reset context\n"));
}

function printToolCall(name, input, wasConfirmed = false) {
  const color = TOOL_COLORS[name] || chalk.white;
  const prefix = DESTRUCTIVE_TOOLS.has(name) ? "⚠️  " : "🔧 ";
  const confirmed = wasConfirmed ? chalk.green(" [CONFIRMED]") : "";

  console.log(color(`\n${prefix}Tool: ${name}${confirmed}`));

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

  console.log(chalk.red.bold("\n╔══════════ ⚠️  CONFIRMATION REQUIRED ══════════╗"));
  console.log(chalk.red(`   Action:       ${actionDesc}`));
  console.log(chalk.red(`   Justification: ${tool.input.justification}`));
  console.log(chalk.red.bold("╚════════════════════════════════════════════════╝"));
  console.log(chalk.yellow("\nType 'yes' to confirm, anything else to cancel:"));

  return new Promise(resolve => {
    rl.question(chalk.yellow("  > "), answer => {
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  Main REPL loop
// ─────────────────────────────────────────────────────────────

async function main() {
  validateConfig();
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const rlQuestion = (prompt) =>
    new Promise(resolve => rl.question(prompt, resolve));

  let conversationHistory = [];

  const callbacks = {
    onToolCall:           printToolCall,
    onThinking:           printThinking,
    onConfirmationNeeded: () => {} // handled below
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
      conversationHistory = [];
      console.log(chalk.gray("  Conversation history cleared.\n"));
      continue;
    }

    // Add user message to history
    conversationHistory.push({ role: "user", content: userInput });

    try {
      let result = await runAgentLoop(conversationHistory, callbacks);

      // ── Confirmation loop — there may be multiple destructive tools ──
      while (result.type === "confirmation_required") {
        const confirmed = await promptForConfirmation(rl, result.tool);

        if (!confirmed) {
          console.log(chalk.gray("  Action cancelled.\n"));
        }

        result = await resumeAfterConfirmation(
          result.messages,
          result.tool,
          confirmed,
          callbacks
        );
      }

      // Final response
      if (result.type === "response") {
        // Persist updated history (trim trailing newline from thinking indicator)
        process.stdout.write("                    \r"); // clear "Thinking..." line
        console.log(chalk.bold.green("\n🤖 Agent:"));
        printResponse(result.text);
        conversationHistory = result.messages;
      }

    } catch (err) {
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
      if (process.env.DEBUG) console.error(err.stack);
      // Don't push failed messages to history
      conversationHistory.pop();
    }
  }
}

main();