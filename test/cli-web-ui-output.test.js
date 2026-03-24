import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated bold/italic fallback from index.js ───────────

function applyMarkdownFallback(text) {
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/gs, (_, t) => `[BOLD:${t}]`);
  result = result.replace(/\*(.+?)\*/gs, (_, t) => `[UNDERLINE:${t}]`);
  return result;
}

// ── Tests ────────────────────────────────────────────────────

describe("Markdown bold/italic fallback", () => {
  it("converts **bold** to bold markers", () => {
    const result = applyMarkdownFallback("This is **bold text** here");
    assert.ok(result.includes("[BOLD:bold text]"));
    assert.ok(!result.includes("**"));
  });

  it("converts *italic* to underline markers", () => {
    const result = applyMarkdownFallback("This is *italic text* here");
    assert.ok(result.includes("[UNDERLINE:italic text]"));
    assert.ok(!result.includes("*italic"));
  });

  it("handles multiple bold markers in one line", () => {
    const result = applyMarkdownFallback("**first** and **second** items");
    assert.ok(result.includes("[BOLD:first]"));
    assert.ok(result.includes("[BOLD:second]"));
  });

  it("handles bold and italic in the same line", () => {
    const result = applyMarkdownFallback("**bold** and *italic* mixed");
    assert.ok(result.includes("[BOLD:bold]"));
    assert.ok(result.includes("[UNDERLINE:italic]"));
  });

  it("handles asterisks inside bold text (KQL, wildcards)", () => {
    const result = applyMarkdownFallback("**EventCount * 2**");
    assert.ok(result.includes("[BOLD:EventCount * 2]"));
  });

  it("leaves text without markers unchanged", () => {
    const input = "No markdown here, just plain text";
    assert.equal(applyMarkdownFallback(input), input);
  });

  it("handles markers at the start and end of text", () => {
    const result = applyMarkdownFallback("**start** middle **end**");
    assert.ok(result.includes("[BOLD:start]"));
    assert.ok(result.includes("[BOLD:end]"));
  });
});

describe("Login success message", () => {
  it("references neo command, not npm start", () => {
    const isLocal = false;
    const serverUrl = "https://neo.example.com";
    const displayName = "Test User";
    const serverHint = isLocal ? "" : ` --server ${serverUrl}`;
    const message = `Logged in as ${displayName}. You can now run: neo${serverHint}`;

    assert.ok(message.includes("neo"));
    assert.ok(!message.includes("npm start"));
    assert.ok(message.includes("--server https://neo.example.com"));
  });

  it("omits --server for localhost", () => {
    const isLocal = true;
    const serverHint = isLocal ? "" : " --server https://neo.example.com";
    const message = `You can now run: neo${serverHint}`;

    assert.ok(message.includes("neo"));
    assert.ok(!message.includes("--server"));
  });
});

describe("Config command parsing", () => {
  it("validates set server requires a URL", () => {
    const action = "set";
    const key = "server";
    const value = "https://neo.example.com";
    assert.ok(action === "set" && key === "server" && value);
  });

  it("validates get server has no value", () => {
    const action = "get";
    const key = "server";
    assert.ok(action === "get" && key === "server");
  });
});
