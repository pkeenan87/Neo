---
name: ui-review
description: Get a second-opinion code review on UI changes from Gemini CLI. Use this skill whenever the user has just finished making frontend changes (React/JSX/TSX, HTML, CSS, Tailwind, component edits, styling tweaks, new UI features) and wants a sanity check before committing, or whenever the user explicitly asks for a "second opinion," "double check," "UI review," or mentions Gemini in the context of their frontend work. Also trigger proactively after any multi-file UI change if the user has this skill installed — a fresh set of eyes catches accessibility, semantic HTML, and responsive issues that are easy to miss in self-review.
---

# UI Review (via Gemini CLI)

This skill sends the user's recent UI changes to the `gemini` CLI for a second-opinion code review, then reads the critique back and helps the user decide what to act on.

No screenshots — just the code, the diff, and a short intent blurb explaining what the change was supposed to accomplish. Gemini reviews it as a pure code-review task.

---

## When to run this

Run the review when:
- The user just finished a UI change and asks for a double-check, second opinion, or review.
- The user mentions Gemini in the context of reviewing their work.
- You've just completed a non-trivial UI change on the user's behalf and want to verify before handing back.

Skip the review when:
- The diff is trivial (under ~10 changed lines, or only copy/className tweaks with no structural change).
- There is no `gemini` binary on PATH (run `command -v gemini` first — if it's missing, tell the user to install it from https://github.com/google-gemini/gemini-cli and stop).
- `GEMINI_API_KEY` is unset AND there's no cached OAuth session (`gemini auth status` non-zero). Tell the user and stop.

## Workflow

### 1. Gather the intent

Write a 1–3 sentence blurb describing what the change was supposed to accomplish. This is the most important input — without it, Gemini is just doing generic code review. Pull from the conversation context if the user already explained it; otherwise ask:

> "Before I send this to Gemini — what were you trying to accomplish with these changes?"

Keep the blurb short. Good examples:
- "Converting the pricing page from a 3-column grid to a responsive layout that stacks on mobile."
- "Adding keyboard navigation to the settings dropdown so it's accessible."
- "Dark mode support for the dashboard header — should read from the existing ThemeContext."

### 2. Collect the changed files

Prefer the git diff over the full files — Gemini is a better reviewer when it can see what changed, not just the final state. Use:

```bash
git diff HEAD -- <paths>              # unstaged changes
git diff --cached -- <paths>          # staged changes
git diff main...HEAD -- <paths>       # branch against main
```

If the files aren't in git yet (brand new), fall back to sending the full files with `@path` syntax.

### 3. Call Gemini

Compose the prompt by substituting the intent and diff into the template at `prompts/ui-review.md`, then invoke:

```bash
gemini -p "$(cat <skill-dir>/prompts/ui-review.md)

## What I was trying to do
${INTENT}

## Changed files
${FILE_LIST}

## Diff
\`\`\`diff
${DIFF}
\`\`\`
"
```

Notes:
- Use `-p` (non-interactive prompt mode) so you get output to stdout in one shot.
- If the diff is large (> ~500 lines), truncate to the UI-relevant files or send the files with `@path` references instead of the full diff.
- Don't pass `--yolo` or anything that lets Gemini touch the filesystem. This is a read-only review.

### 4. Parse and present the response

The prompt asks Gemini to return JSON of the shape:

```json
{
  "summary": "one-paragraph overall take",
  "issues": [
    {
      "severity": "high" | "medium" | "low" | "nit",
      "file": "src/components/Foo.tsx",
      "line": 42,
      "problem": "...",
      "suggested_fix": "..."
    }
  ],
  "positives": ["things that look good"]
}
```

Parse it and present to the user grouped by severity. Show `high` and `medium` prominently; collapse `low` and `nit` into a "minor" list the user can expand.

If Gemini returns prose instead of JSON (it sometimes does), extract the key points yourself — don't re-prompt unless the response is genuinely unusable.

### 5. Offer to iterate

After presenting the review, ask the user which issues (if any) they want to address. If they want fixes, make them. Cap at **one** follow-up review round — don't ping-pong. If the user wants more rounds after that, they can ask explicitly.

---

## Operational notes

**Corporate proxy / SSL inspection.** If the user's machine is behind an SSL-inspection proxy (common on work laptops), `gemini` CLI's HTTPS calls to Google will fail with cert errors. Detect this by checking for `HTTPS_PROXY` / `HTTP_PROXY` env vars or a well-known corp CA bundle. If present, surface a clear error rather than looping on retries:

> "Looks like you're behind an SSL-inspection proxy — Gemini CLI calls will likely fail. This skill is better suited for personal machines. Want me to just do a self-review instead?"

**Cost.** Each review is one Gemini call. The trivial-change skip (step 1's gate) exists to keep this from running on every tiny edit.

**Model selection.** If the user has a preferred Gemini model, use `gemini -m <model>`. Default is fine otherwise — don't hardcode a model in the skill since the good one changes every few months.

**What to review for.** The prompt at `prompts/ui-review.md` biases Gemini toward things Claude tends to miss on pure code review: accessibility (ARIA, keyboard nav, contrast reasoning from class names), semantic HTML, responsive behavior inferred from Tailwind breakpoints, dead or conflicting className combinations, state/prop mistakes, and React anti-patterns. It explicitly tells Gemini *not* to rewrite the whole component or bikeshed on style preferences.
