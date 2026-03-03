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
│   └── src/
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
- **`lib/`** — Shared server-side logic (agent, tools, executors, auth, config, types)

## Key Design Patterns

**Confirmation gate**: Destructive tools (`reset_user_password`, `isolate_machine`, `unisolate_machine`) pause the agentic loop and return control to the CLI for user confirmation. The loop resumes via `resumeAfterConfirmation()`.

**Tool classification**: Tools are either read-only (executed autonomously) or destructive (require confirmation). This is controlled by the `DESTRUCTIVE_TOOLS` Set in `tools.js`.

**Mock/Live dual-path**: Every executor function checks `env.MOCK_MODE` and branches to either mock data or real API calls. When adding new tools, follow this same pattern.

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
- Azure credentials: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTION_ID`
- Sentinel: `SENTINEL_WORKSPACE_ID`, `SENTINEL_WORKSPACE_NAME`, `SENTINEL_RESOURCE_GROUP`

## Next.js / React Styling Preferences

### Component Structure
Every component lives in its own folder:
```
components/ComponentName/
  ComponentName.tsx
  ComponentName.module.css   (only if 4+ Tailwind classes needed on any element)
  index.ts                   (barrel export)
```

All components roll up to `components/index.ts`. Always import from the barrel (`@/components`), never deep imports.

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
