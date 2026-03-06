# Fix Skill Context Loading

> Fix the agent's skill loading so that available skills (e.g., tor-login-investigation) are reliably injected into the system prompt and the agent can discover and follow them.

## Problem

Skills defined in `web/skills/` (such as `tor-login-investigation.md`) are not being surfaced to the agent. When a user asks the agent to investigate a TOR login, it does not know the skill exists and improvises instead of following the defined investigation steps. There are two dimensions to this problem:

1. **Path resolution in production**: The `skill-store.ts` module uses `__dirname` (derived from `import.meta.url`) to locate the `skills/` directory. In the Next.js standalone build output, the compiled server files live in `.next/standalone/web/` and the `skills/` directory is not copied into the standalone output. This means `loadSkillsFromDisk()` silently finds no files in production.

2. **Agent awareness**: Even when skills load correctly (in development), the agent has no explicit way to tell the user which skills are available. The skills are silently appended to the system prompt, but there is no mechanism for the agent to list available skills on request, and no user-facing indication that skill-driven investigation workflows exist.

## Goals

- Ensure skills load reliably in both development (`npm run dev`) and production (standalone build / Azure App Service)
- Make the agent aware of available skills so it can list them and suggest them when relevant
- Ensure the `tor-login-investigation` skill (and any future skills) is injected into the system prompt and followed when the user's request matches

## Non-Goals

- Changing the skill file format or parsing logic
- Adding new skills beyond what already exists in `web/skills/`
- Building a user-facing skill management UI
- Changing the skill validation rules or hot-reload behavior
- Supporting skills in the CLI project (separate codebase)

## User Stories

1. **As a SOC analyst**, when I ask Neo to investigate a TOR login for a user, the agent follows the defined investigation steps (gather user context, confirm TOR login, check impossible travel, etc.) instead of improvising.
2. **As a SOC analyst**, I can ask "what skills do you have?" and the agent lists the available investigation workflows with their names and descriptions.
3. **As a platform admin**, when I deploy Neo to Azure App Service, the skills directory is included in the deployment artifact and skills load correctly at server startup.

## Design Considerations

### Path Resolution Fix

The `SKILLS_DIR` in `skill-store.ts` is currently resolved relative to `__dirname` using `import.meta.url`. In the standalone build, Next.js compiles server code and places it in `.next/standalone/web/`, but does not copy the `skills/` directory. There are two aspects to fix:

- The path resolution strategy needs to work in both development and production environments
- The deployment script (`scripts/deploy-azure.ps1`) needs to include the `skills/` directory in the packaged zip artifact alongside `public/` and `.next/static/`

### Deployment Script Update

The `deploy-azure.ps1` script currently packages `standalone/`, `public/`, and `.next/static/`. The `skills/` directory needs to be added to the packaging step so it is present in the deployed artifact on Azure App Service.

### Agent Skill Awareness

The system prompt already appends skill blocks under an `## AVAILABLE SKILLS` section. The issue may be that the skills are not loading (path resolution), not that the prompt structure is wrong. Once skills load correctly, the agent should naturally be able to reference them.

Consider whether the system prompt section header and introduction text are clear enough for the model to proactively suggest matching skills to users, or whether additional instruction is needed (e.g., "When listing capabilities, include these skills by name").

## Key Files

- `web/lib/skill-store.ts` — Fix `SKILLS_DIR` path resolution for both dev and production environments
- `scripts/deploy-azure.ps1` — Add `skills/` directory to the deployment package
- `web/lib/config.ts` — Potentially adjust the `AVAILABLE SKILLS` section text to improve agent awareness
- `web/next.config.js` — May need adjustment if path resolution requires config changes

## Open Questions

1. Should the skills directory path be configurable via an environment variable (e.g., `SKILLS_DIR`) to allow flexibility in deployment, or is a convention-based path sufficient? convention is good enough.
2. Should the agent proactively suggest skills when it detects a matching user query (e.g., "I have a TOR Login Investigation skill — would you like me to follow it?"), or should it silently follow matching skills as instructed in the current system prompt text? yes proactively suggest.
