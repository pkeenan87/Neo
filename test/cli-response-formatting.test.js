import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatForTerminal } from "../cli/src/format-terminal.js";

describe("formatForTerminal", () => {
  it("inserts a blank line before a list block that follows a paragraph", () => {
    const input = "Here is a list:\n- item one\n- item two";
    const result = formatForTerminal(input);
    assert.ok(
      result.includes("Here is a list:\n\n- item one"),
      "Expected blank line before first list item"
    );
    // Second item should NOT get an extra blank line (it follows another list item)
    assert.ok(
      result.includes("- item one\n- item two"),
      "List items should stay consecutive"
    );
  });

  it("strips <br> and <br/> tags and replaces with newlines", () => {
    const input = "line one<br>line two<br/>line three";
    const result = formatForTerminal(input);
    assert.ok(!result.includes("<br"), "No <br> tags should remain");
    assert.ok(result.includes("line one\nline two\nline three"));
  });

  it("converts Unicode bullets to markdown bullets", () => {
    const input = "• First item\n• Second item";
    const result = formatForTerminal(input);
    assert.ok(result.includes("- First item"), "Unicode bullet should become - ");
    assert.ok(result.includes("- Second item"));
  });

  it("converts HTML inline tags to markdown equivalents", () => {
    const input = "<strong>bold</strong> and <em>italic</em> and <code>code</code>";
    const result = formatForTerminal(input);
    assert.ok(result.includes("**bold**"), "strong → **bold**");
    assert.ok(result.includes("*italic*"), "em → *italic*");
    assert.ok(result.includes("`code`"), "code → `code`");
  });

  it("strips remaining HTML tags but preserves content", () => {
    const input = "<div>content inside div</div>";
    const result = formatForTerminal(input);
    assert.ok(!result.includes("<div>"), "No <div> tags should remain");
    assert.ok(result.includes("content inside div"));
  });

  it("passes plain text through unchanged", () => {
    const input = "Just a normal sentence with no formatting.";
    const result = formatForTerminal(input);
    assert.strictEqual(result, input);
  });

  it("collapses 4+ blank lines into exactly 2", () => {
    const input = "paragraph one\n\n\n\n\nparagraph two";
    const result = formatForTerminal(input);
    assert.ok(
      result.includes("paragraph one\n\n\nparagraph two"),
      "Should collapse to exactly 2 blank lines (3 newlines)"
    );
    assert.ok(
      !result.includes("\n\n\n\n"),
      "Should not have 4+ consecutive newlines"
    );
  });

  it("normalizes * and + bullet markers to -", () => {
    const input = "list:\n* item a\n+ item b\n- item c";
    const result = formatForTerminal(input);
    assert.ok(result.includes("- item a"), "* should become -");
    assert.ok(result.includes("- item b"), "+ should become -");
    assert.ok(result.includes("- item c"), "- should remain -");
  });
});
