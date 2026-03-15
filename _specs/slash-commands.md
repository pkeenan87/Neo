# Spec for Slash Commands

branch: claude/feature/slash-commands

## Summary

Add slash command support to both the CLI and Web chat interfaces, allowing users to directly invoke skills by typing `/<skill-id>`. When a user types `/` in the input, an autocomplete menu appears showing available skills filtered by the user's role. Selecting a command sends the skill's instructions as context to the agent, which then follows the skill's steps. Teams is out of scope — commands there are managed via the app manifest.

## Functional requirements

- When the user types `/` as the first character of a message in the Web chat input, a floating autocomplete popover appears above the input showing available skills.
- The popover shows each skill's name and a short description, filtered to skills available for the user's role.
- As the user continues typing after `/`, the list filters by skill ID and name (case-insensitive substring match).
- Selecting a skill from the popover (click or keyboard Enter/Tab) replaces the input with `/<skill-id>` and submits it.
- If the skill has parameters defined, the input is populated with `/<skill-id>` and a placeholder prompt for the parameters, and the user fills in the parameters before submitting.
- On submit, the message is intercepted before being sent to the agent. The skill's instructions are prepended as context so the agent follows the skill's prescribed steps.
- In the CLI REPL, typing `/<skill-id>` at the prompt triggers the same behavior — the skill's instructions are prepended to the message sent to the agent. No popover is needed in the CLI, but a `/help` or `/skills` command should list available skills.
- The server-side API route detects messages starting with `/` and resolves the skill from the skill store, prepending the instructions to the user message before passing it to the agent loop.
- If a user types a `/` command that doesn't match any skill, the message is sent as-is to the agent (no error — the agent can respond naturally).
- Skills that require the `admin` role are not shown in the autocomplete for `reader` users and are rejected server-side if a reader tries to invoke them.

## Possible Edge Cases

- User types `/` in the middle of a message (not the first character) — treat as a regular message, no autocomplete.
- User types `/` then immediately sends without selecting a skill — send as-is.
- Skill has parameters but user doesn't provide them — the agent should ask for the missing information.
- Skill is deleted between the user seeing it in autocomplete and submitting — server returns skill-not-found and sends the message as-is.
- User types `/` but there are no skills configured — popover shows "No skills available" message.
- Multiple rapid `/` keystrokes — debounce or ignore to avoid flickering.
- Popover positioning when the input is near the top of the viewport — ensure the popover doesn't overflow offscreen.

## Acceptance Criteria

- Typing `/` in the Web chat input shows a floating popover with available skills filtered by role.
- Typing additional characters after `/` filters the skill list in real-time.
- Clicking or pressing Enter on a skill submits it as a slash command.
- The agent receives the skill's instructions and follows the prescribed investigation steps.
- In the CLI, typing `/<skill-id>` at the prompt invokes the corresponding skill.
- `/skills` in the CLI lists all available skills with their names and descriptions.
- Admin-only skills are hidden from readers and rejected server-side.
- Regular messages (not starting with `/`) are unaffected.

## Open Questions

- Should the popover show skill parameters inline (e.g. `/<skill-id> <param1> <param2>`) or let the agent ask for them? Yes it should show inline.
- Should there be a visual indicator in the chat thread that a skill was invoked (e.g. a badge or system message)? Yes.
- Should `/` commands be logged as skill invocations in the audit trail? yes.

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Message starting with `/<valid-skill-id>` is detected as a slash command.
- Message starting with `/<invalid-id>` is passed through as a regular message.
- Skill filtering by role works correctly (admin skills hidden from readers).
- Skill instructions are correctly prepended to the agent message.
- Messages not starting with `/` are unaffected.
- CLI `/skills` command lists available skills.
