/**
 * Pre-process markdown before passing to marked-terminal.
 * Strips HTML tags, normalizes bullets, and ensures blank lines before lists.
 */
export function formatForTerminal(text) {
  let result = text;

  // 1. Strip <br> and <br/> tags → newline
  result = result.replace(/<br\s*\/?>/gi, "\n");

  // 2. Convert HTML inline formatting to markdown
  result = result.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
  result = result.replace(/<em>(.*?)<\/em>/gi, "*$1*");
  result = result.replace(/<code>(.*?)<\/code>/gi, "`$1`");

  // 3. Strip remaining HTML tags (preserve content between them)
  result = result.replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, "");

  // 4. Convert Unicode bullets to markdown bullets
  result = result.replace(/^(\s*)•\s*/gm, "$1- ");

  // 5. Ensure blank lines before list blocks and
  // 6. Normalize bullet markers (* and + → -)
  const lines = result.split("\n");
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Normalize * and + bullet prefixes to -
    line = line.replace(/^(\s*)[*+]\s+/, "$1- ");

    const isListItem = /^\s*(?:- |\d+\.\s)/.test(line);
    if (isListItem && i > 0) {
      const prevLine = output[output.length - 1];
      const prevIsBlank = prevLine === undefined || prevLine.trim() === "";
      const prevIsList = prevLine !== undefined && /^\s*(?:- |\d+\.\s)/.test(prevLine);
      if (!prevIsBlank && !prevIsList) {
        output.push("");
      }
    }

    output.push(line);
  }
  result = output.join("\n");

  // 7. Collapse runs of 3+ blank lines into exactly 2
  result = result.replace(/\n{4,}/g, "\n\n\n");

  return result;
}
