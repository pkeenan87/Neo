import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAutoTitle, messageToPlainText, sanitizeTitle } from "../web/lib/extract-auto-title.ts";

describe("extractAutoTitle", () => {
  it("returns the first user message text", () => {
    const messages = [
      { role: "user", content: "Check suspicious login from Russia" },
      { role: "assistant", content: "I'll investigate that for you." },
    ];
    assert.strictEqual(extractAutoTitle(messages), "Check suspicious login from Russia");
  });

  it("returns undefined when no user message exists", () => {
    const messages = [
      { role: "assistant", content: "Hello, how can I help?" },
    ];
    assert.strictEqual(extractAutoTitle(messages), undefined);
  });

  it("truncates messages longer than 200 characters", () => {
    const longMessage = "a".repeat(250);
    const messages = [{ role: "user", content: longMessage }];
    const result = extractAutoTitle(messages);
    assert.strictEqual(result.length, 203); // 200 + "..."
    assert.ok(result.endsWith("..."));
  });

  it("strips control characters from the message", () => {
    const messages = [{ role: "user", content: "Hello\x00\x01World\x7F" }];
    assert.strictEqual(extractAutoTitle(messages), "HelloWorld");
  });

  it("strips HTML-significant characters to prevent XSS", () => {
    const messages = [{ role: "user", content: '<script>alert("xss")</script> hello' }];
    const result = extractAutoTitle(messages);
    assert.ok(!result.includes("<"), "should not contain <");
    assert.ok(!result.includes(">"), "should not contain >");
    assert.ok(!result.includes('"'), 'should not contain "');
    assert.ok(result.includes("hello"));
  });

  it("handles content array format", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "second part" },
        ],
      },
    ];
    assert.strictEqual(extractAutoTitle(messages), "First part second part");
  });

  it("returns undefined for empty or whitespace-only content", () => {
    const messages = [{ role: "user", content: "   " }];
    assert.strictEqual(extractAutoTitle(messages), undefined);
  });

  it("handles Unicode truncation without splitting surrogate pairs", () => {
    const emoji = "\u{1F600}"; // 😀 — a surrogate pair in UTF-16
    const messages = [{ role: "user", content: emoji.repeat(201) }];
    const result = extractAutoTitle(messages);
    assert.ok(result.endsWith("..."));
    // Should not contain orphaned surrogates
    assert.ok(!result.includes("\uFFFD"), "no replacement characters");
  });
});

describe("messageToPlainText", () => {
  it("returns string content directly", () => {
    assert.strictEqual(messageToPlainText("hello"), "hello");
  });

  it("joins text blocks from content array", () => {
    const content = [
      { type: "text", text: "part one" },
      { type: "image", source: {} },
      { type: "text", text: "part two" },
    ];
    assert.strictEqual(messageToPlainText(content), "part one part two");
  });

  it("returns empty string for non-string non-array content", () => {
    assert.strictEqual(messageToPlainText(undefined), "");
  });
});

describe("sanitizeTitle", () => {
  it("strips HTML chars and control chars", () => {
    const result = sanitizeTitle('<b>bold</b> & "quoted"');
    assert.strictEqual(result, "bbold/b  quoted");
  });

  it("returns undefined for empty input", () => {
    assert.strictEqual(sanitizeTitle(""), undefined);
    assert.strictEqual(sanitizeTitle("   "), undefined);
  });
});
