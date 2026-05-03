# Contributing to Neo

Thanks for your interest in contributing. This guide covers everything you need to land a change — from local setup to opening a PR.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

For **security vulnerabilities**, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

---

## Project layout

The repo is a monorepo with two independent projects that share concepts but no code:

```
Neo/
├── cli/      # Terminal REPL client (Node ESM, no framework)
├── web/      # Next.js 15 App Router server (React 19, TypeScript, Tailwind v4)
├── docs/     # User + configuration guides
├── scripts/  # Azure deployment + provisioning PowerShell
└── .github/  # CI workflows, issue templates, CODEOWNERS, security policy
```

CLI and web each have their own `package.json`; install dependencies separately. See [CLAUDE.md](CLAUDE.md) for a deeper architecture brief.

---

## Local setup

You need **Node.js 20+** and **npm**. Azure credentials are optional — `MOCK_MODE=true` runs the agent against fixture data.

```bash
# Clone
git clone https://github.com/pkeenan87/Neo.git
cd Neo

# Web server
cd web
npm install
cp .env.example .env       # set ANTHROPIC_API_KEY at minimum
npm run dev                # http://localhost:3000

# CLI (in a second terminal)
cd cli
npm install
npm start                  # connects to NEO_SERVER_URL (default http://localhost:3000)
```

Set `MOCK_MODE=true` in `.env` (the default) to develop without real Azure / vendor credentials. All executors have parallel mock and live code paths gated by this flag — please test your changes in mock mode first.

---

## Adding a new tool

The CLI and web each expose tools to the Claude agent. The shape is the same on both sides; the executor lives in different files.

**For the CLI** (`cli/src/`):
1. Add the tool schema to the `TOOLS` array in `tools.js`.
2. If destructive (mutates external state), add the tool name to `DESTRUCTIVE_TOOLS` so the confirmation gate fires.
3. Implement the executor in `executors.js` with **both** mock and real paths gated by `env.MOCK_MODE`.
4. Register it in the `executors` object at the bottom of `executors.js`.
5. Optionally add a colour mapping in `TOOL_COLORS` and a description in `TOOL_DESCRIPTIONS` in `index.js`.

**For the web** (`web/lib/`):
1. Add the tool schema to `tools.ts`.
2. If destructive, add it to the `DESTRUCTIVE_TOOLS` set in `tools.ts`.
3. Implement the executor in `executors.ts` with both mock and real paths.
4. Wire it into the dispatch table at the bottom of `executors.ts`.
5. Update `permissions.ts` if the tool should be gated by RBAC role.

Read-only tools execute automatically. Destructive tools pause the agent loop and require explicit user confirmation before running.

---

## Code style

### TypeScript / React (web)

The full conventions are documented in [CLAUDE.md](CLAUDE.md#nextjs--react-styling-preferences). The non-negotiables:

- **No `any`.** Use proper types or `unknown` + narrow.
- **Tailwind v4 + CSS Modules.** Maximum 3 inline Tailwind classes; extract to a `.module.css` file when you need a 4th.
- **Design tokens only.** Use the `brand-*` / `accent-*` / `surface-*` / `border-*` scales from `tailwind.config.ts`. No raw hex values.
- **No `hover:opacity-80`.** Always use explicit shade tokens (one step darker/lighter).
- **Path aliases.** `@/` for project imports; never deep-import from a component folder, always go through the barrel export.

### JavaScript (CLI)

ES modules (`"type": "module"`). No build step in development — `node --no-deprecation src/index.js` runs the source directly.

### Comments

Prefer self-explaining identifiers over comments. Add a comment only when the **why** is non-obvious — a hidden constraint, a workaround, a security invariant. Don't restate what the code does.

### Tests

Both surfaces have tests under `test/` (or `web/test/` for web-specific). Run before opening a PR:

```bash
cd web && npm run typecheck && npm run lint && npm run test
cd cli && npm install                      # CLI has no test suite yet; install must succeed
```

---

## Commit messages

The repo uses emoji-prefixed conventional commits. The first line should fit on one line of `git log --oneline`:

```
<emoji> <type>(<scope>): <short summary>
```

Examples from history:

- `✨ feat(settings): admin UI for skills CRUD`
- `🔨 fix(settings): address Gemini UI review feedback`
- `🐛 fix(cli): pin marked back to 15.0.12 — peer-dep conflict`
- `🔒 fix(integrations): validate THREATLOCKER_INSTANCE in probe to prevent SSRF`
- `📝 docs(repo): add badges, releases, contributing — and path-filter CI`

Use the body to explain the **why**. The diff already shows the **what**.

Common emoji choices: ✨ feat · 🐛 fix · 🔨 fix (refactor) · 🔒 security · 📝 docs · ⚡ perf · 🧪 test · 🚀 release · ⬆️ deps.

---

## Submitting a PR

1. Fork the repo and create a feature branch off `main`.
2. Make your change. Keep PRs focused — one logical change per PR.
3. Run typecheck, lint, and tests locally.
4. Push and open a PR against `main`. Fill in the PR template.
5. CI will run typecheck, lint, tests, `npm audit`, [CodeQL](https://codeql.github.com/) (security-extended), and [gitleaks](https://github.com/gitleaks/gitleaks). Address any failures before requesting review.
6. CODEOWNERS will auto-suggest reviewers based on which files you touched.

PRs that touch security-sensitive files (`/web/lib/auth*.ts`, `/web/lib/permissions.ts`, `/web/lib/secrets.ts`, `/web/lib/api-key-*.ts`, `/web/lib/injection-guard.ts`) will get extra scrutiny — please flag the security implications in the PR description.

---

## Releases

Versioning is per-surface, not unified:

- CLI releases are tagged `cli-vMAJOR.MINOR.PATCH`.
- Web releases are tagged `web-vMAJOR.MINOR.PATCH` and serve as deployment markers.

If your change is user-visible, mention it in the PR description so it can be included in the auto-generated release notes when the next version is cut.

---

## Questions

Open a [GitHub Discussion](https://github.com/pkeenan87/Neo/discussions) (if enabled) or a `[question]`-prefixed issue. For private questions, the SECURITY.md contact channel works for non-security questions too.
