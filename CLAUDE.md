# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Security Agent ("Neo") — a Claude-powered SOC analyst agent with both a CLI and web interface. It investigates security incidents via Microsoft Sentinel KQL, Defender XDR, and Entra ID, and can execute containment actions (password reset, machine isolation) with human confirmation gates.

## Project Structure

The repo is split into two independent projects with no cross-imports:

```
neo/
├── cli/          # Terminal REPL agent
│   ├── package.json
│   ├── src/
│   ├── build/    # Windows installer build scripts (PowerShell + Inno Setup)
│   └── sea-config.json
├── web/          # Next.js web interface
│   ├── package.json
│   ├── app/
│   └── lib/
├── .env          # Shared environment variables (root level)
└── CLAUDE.md
```

## Commands

```bash
# CLI
cd cli && npm install    # Install CLI dependencies
cd cli && npm start      # Run the CLI (node --no-deprecation src/index.js)
cd cli && npm run dev    # Run with --watch for auto-reload during development

# CLI — Windows installer build (run on Windows)
cd cli && npm run release       # Full pipeline: bundle → SEA → sign → installer
cd cli && npm run build:bundle  # esbuild ES modules → single CJS file
cd cli && npm run build:sea     # Generate SEA blob and inject into node.exe
cd cli && npm run build:sign    # Authenticode-sign dist/neo.exe
cd cli && npm run build:installer  # Compile Inno Setup installer and sign it

# Web
cd web && npm install    # Install web dependencies
cd web && npm run dev    # Run Next.js dev server (localhost:3000)
cd web && npm run build  # Production build
```

Set `MOCK_MODE=true` (default) in `.env` to test without Azure credentials. Set `MOCK_MODE=false` and provide Azure credentials for live API calls.

## Architecture

### CLI (`cli/src/`)

All source uses ES modules (`"type": "module"` in package.json).

- **`index.js`** — CLI REPL, readline interface, colored terminal output, confirmation prompts. Entry point.
- **`agent.js`** — Agentic loop that calls Claude API repeatedly until `end_turn` or a destructive tool needs confirmation. `runAgentLoop()` handles the main loop; `resumeAfterConfirmation()` resumes after user confirms/cancels.
- **`tools.js`** — Tool schemas (passed to Claude's `tools` parameter). `DESTRUCTIVE_TOOLS` Set defines which tools require confirmation.
- **`executors.js`** — Tool implementations. Each tool function has dual paths: mock data (for `MOCK_MODE=true`) and real Azure API calls. The `executeTool()` router dispatches by tool name.
- **`config.js`** — Environment variable loading (dotenv), validation, and the system prompt.
- **`auth.js`** — Azure AD OAuth2 client_credentials flow with in-memory token caching. `getAzureToken(resource)` for any Azure resource, `getMSGraphToken()` convenience wrapper.

### Web (`web/`)

Next.js app with server-side Claude API integration.

- **`app/`** — Next.js app router pages and API routes
  - **`app/chat/`** — Main chat interface (auth-gated via `getAuthContext()`)
  - **`app/settings/`** — Settings page with General (profile, appearance) and Usage (token budget progress bars) tabs
  - **`app/api/usage/`** — GET endpoint returning per-user token usage summaries
- **`lib/`** — Shared server-side logic (agent, tools, executors, auth, config, types)
- **`lib/context-manager.ts`** — Context window management: token estimation, per-tool-result truncation, Haiku-powered rolling conversation compression
- **`lib/usage-tracker.ts`** — Per-user token usage tracking with Cosmos DB, pessimistic budget reservations, rolling window enforcement (2-hour and weekly)
- **`context/ThemeContext.tsx`** — Theme provider supporting `'light'` | `'dark'` modes. Stored in `localStorage` key `neo-theme`
- **`components/SettingsPage/`** — Settings page components (SettingsPage, ProfileSection, AppearanceSection, UsageSection, ProgressBar)

## Key Design Patterns

**Confirmation gate**: Destructive tools (`reset_user_password`, `isolate_machine`, `unisolate_machine`) pause the agentic loop and return control to the CLI for user confirmation. The loop resumes via `resumeAfterConfirmation()`.

**Tool classification**: Tools are either read-only (executed autonomously) or destructive (require confirmation). This is controlled by the `DESTRUCTIVE_TOOLS` Set in `tools.js`.

**Mock/Live dual-path**: Every executor function checks `env.MOCK_MODE` and branches to either mock data or real API calls. When adding new tools, follow this same pattern.

**Context window management**: The `context-manager.ts` module sits between the session's full message history and the Claude API call. Before each API call, `prepareMessages()` truncates oversized tool results (50K token cap), and compresses older messages via Haiku when context exceeds 160K tokens. Full untrimmed messages remain in session storage. The `get_full_tool_result` tool lets the agent re-fetch truncated results.

**Token optimization**: The agent loop uses Anthropic prompt caching (`cache_control: { type: "ephemeral" }`) on both the system prompt and tool schemas. Default model is Sonnet (user-selectable to Opus). Per-user token budgets (2-hour and weekly rolling windows) are enforced via pessimistic reservations in Cosmos DB before the agent loop runs.

**Client-side preferences**: User display name (`neo-display-name`) and theme preference (`neo-theme`) are stored in `localStorage`. The settings page (`/settings`) provides the UI for these.

## Adding a New Tool (CLI)

1. Add the tool schema to the `TOOLS` array in `cli/src/tools.js`
2. If destructive, add the tool name to `DESTRUCTIVE_TOOLS` in `cli/src/tools.js`
3. Add the executor function in `cli/src/executors.js` with both mock and real implementations
4. Register it in the `executors` object at the bottom of `cli/src/executors.js`
5. Optionally add a color mapping in `TOOL_COLORS` and a description in `TOOL_DESCRIPTIONS` in `cli/src/index.js`

## Dependencies

### CLI (`cli/package.json`)
- `@anthropic-ai/sdk` — Claude API client (uses `claude-opus-4-5` model)
- `chalk` — Terminal colors
- `dotenv` — Environment variable loading

### Web (`web/package.json`)
- `next`, `react`, `react-dom` — Next.js framework
- `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `autoprefixer` — Styling
- `@anthropic-ai/sdk` — Claude API client
- `dotenv` — Environment variable loading
- `typescript`, `@types/node`, `@types/react` — TypeScript support

## Environment Variables

Configured via `.env` file (see `.env.example`):
- `ANTHROPIC_API_KEY` (required)
- `MOCK_MODE` (default: true)
- `NEO_SERVER_URL` — Default server URL for the CLI (falls back to `http://localhost:3000`)
- Azure credentials: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`
- Sentinel: `SENTINEL_WORKSPACE_ID`, `SENTINEL_WORKSPACE_NAME`, `SENTINEL_RESOURCE_GROUP`

## Next.js / React Styling Preferences

### Tailwind v4 + CSS Modules Setup

This project uses **Tailwind v4** with `@tailwindcss/postcss`. Custom design tokens are defined in `web/tailwind.config.ts` and bridged into the v4 CSS pipeline via `@config "../tailwind.config.ts"` in `web/app/globals.css`.

**Critical: `@apply` in CSS modules requires `@reference`**. Every `.module.css` file that uses `@apply` MUST start with:
```css
@reference "../../app/globals.css";
```
Adjust the relative path based on the file's location. Without this, `@apply` directives are silently dropped during Turbopack compilation and CSS module class names resolve to `undefined` at runtime. The `@reference` directive imports the Tailwind context (including all custom tokens from `tailwind.config.ts`) without emitting any CSS.

The PostCSS config at `web/postcss.config.mjs` wires `@tailwindcss/postcss` into the build pipeline so CSS modules are processed through Tailwind.

### Component Structure
Every component lives in its own folder:
```
components/ComponentName/
  ComponentName.tsx
  ComponentName.module.css   (only if 4+ Tailwind classes needed on any element)
  index.ts                   (barrel export)
```

All components roll up to `components/index.ts`. Always import from the barrel (`@/components`), never deep imports.

Canonical component patterns for Button, Card, Input, NavBar, Modal, and Badge are defined in `.claude/skills/ui-standards-refactor/references/component-patterns.md`. Use these as the baseline when building new components — they enforce the 3-class rule, correct hover patterns, and proper TypeScript shapes.

### The 3-Class Inline Rule
Maximum 3 Tailwind classes inline on any JSX element. When a 4th is needed, extract ALL classes for that element into a CSS Module using `@apply`.
```tsx
// ✅ OK
<div className="flex items-center gap-4">

// ✅ OK — 4+ classes
<div className={styles.cardWrapper}>

// ❌ Never
<div className="flex items-center gap-4 rounded-xl bg-white shadow-md px-6 py-4">
```

CSS module class names use **camelCase semantic names** (`.cardWrapper`, `.primaryButton`) — never visual names (`.flexRow`, `.bgWhite`).

### Design Tokens

All colors must come from the design token scales in `tailwind.config.ts`. Never use arbitrary hex values in JSX or CSS modules when a token exists.

| Token | Usage |
|-------|-------|
| `brand-50` through `brand-900` | Primary UI (Slate scale in light mode) |
| `accent-400`, `accent-500` | Dark mode primary brand (Green scale) |
| `surface-default`, `surface-raised`, `surface-sunken`, `surface-overlay` | Background surfaces |
| `border-default`, `border-strong` | Borders and dividers |
| `success-500`, `error-500`, `warning-500` | Semantic status colors |
| `shadow-card`, `shadow-card-hover`, `shadow-modal`, `shadow-dropdown` | Elevation |

### Hover States
Never use `hover:opacity-80`. Always use explicit shade tokens (one step darker/lighter):
```css
.primaryButton { @apply bg-brand-600 transition-colors duration-150; }
.primaryButton:hover { @apply bg-brand-700; }

.card { @apply shadow-card transition-shadow duration-150; }
.card:hover { @apply shadow-card-hover; }

.ghostButton { @apply bg-transparent transition-colors duration-150; }
.ghostButton:hover { @apply bg-brand-50; }
```

### Dark Mode
Dark mode is class-based (`.dark` on `<html>`), managed by `ThemeContext`. In CSS modules, use `:global(html.dark)` selector:
```css
.container { @apply bg-surface-default; }
:global(html.dark) .container { @apply bg-brand-900; }
```
Dark mode accent color is green (`#22c55e` primary, `#4ade80` hover, `rgba(34, 197, 94, ...)` for opacity variants).

### TypeScript Conventions
- No `any` — ever. Use proper types or `unknown` + narrow.
- Props interfaces named `ComponentNameProps`, always exported.
- Variants as union literals: `variant: 'primary' | 'secondary'`
- All optional props have defaults in destructuring.
- Always accept `className?: string` as last prop, forwarded to outermost element.

### Spacing (8pt Grid)
Only use: `2 / 4 / 8 / 16 / 32` (0.5 / 1 / 2 / 4 / 8rem). Avoid `px-3`, `py-5`, `gap-6`, `mt-7` as primary layout spacing.

### Typography
- Never use `font-sans`/`font-mono` — use named font tokens (`font-display`, `font-body`).
- Size and weight always travel together (`text-3xl font-bold`).
- `tracking-tight` for headings 2xl+, `tracking-normal` otherwise.
- Use semantic HTML heading elements (`h1`–`h6`), never a `div` styled as a heading.

### Accessibility
- All interactive elements must have visible `:focus-visible` styles (use `outline` or `box-shadow`, never remove focus indicators without replacement).
- Use ARIA tablist/tab/tabpanel pattern for within-page tab navigation (not `<nav>`).
- `role="progressbar"` goes on the track element, not the fill. Use `aria-valuetext` for human-readable values.
- Group related controls with `role="group"` + `aria-labelledby` or `<fieldset>`/`<legend>`.
- Gate animations behind `@media (prefers-reduced-motion: no-preference)`.
- Use `aria-live="polite"` for dynamic status text (e.g., loading states, timestamps).
- Decorative icons get `aria-hidden="true"`.

### Next.js Specifics
- Images: `next/image` with explicit dimensions or `fill` + `sizes`
- Links: `next/link` — never `<a>` for internal routes
- Fonts: `next/font` declared in `app/layout.tsx`, passed as CSS variable
- Path aliases: `@/` for all project imports
- Default to Server Components; add `'use client'` only when state/events require it

### Anti-Patterns to Avoid
| ❌ Avoid | ✅ Use instead |
|---|---|
| `hover:opacity-80` | Explicit shade token |
| 4+ inline Tailwind classes | CSS module utility class |
| `text-[#3B82F6]` arbitrary color | Design token |
| `style={{}}` prop | Tailwind or CSS module |
| Deep component imports | Barrel import from `@/components` |
| `<a href="/page">` | `<Link href="/page">` |
| `any` type | Proper interface or `unknown` |
| CSS module without `@reference` | Add `@reference "../../app/globals.css"` at top |
| Raw CSS values when token exists | Use `@apply` with design token |
| `outline: none` without replacement | `:focus-visible` with box-shadow or outline |
