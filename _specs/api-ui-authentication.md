# API and UI Authentication

> Add authentication to the Next.js API and future UI using NextAuth.js with two providers — Entra ID (OAuth) and API Key (custom credentials) — and a role-based permission system (Reader / Admin) that governs which agent tools each identity can invoke.

## Problem

The API currently has no authentication. Any HTTP client can call `/api/agent` and execute tool calls — including destructive actions like password resets and machine isolation — without any identity verification. Before the web UI is built or the API is exposed beyond localhost, we need authentication and role-based access control.

## Goals

- Authenticate API and UI requests via two mechanisms: **Entra ID (OAuth/OIDC)** and **API Key (bearer token)**
- Define two roles — **Admin** and **Reader** — with permissions managed in a single library file
- Admin has access to all tools (read-only and destructive)
- Reader has access to read-only tools only (tools not in the `DESTRUCTIVE_TOOLS` set are allowed)
- The permission system should be the single source of truth for both Entra ID users and API key holders
- Protect all `/api/agent/*` routes — unauthenticated requests receive `401`
- Protect destructive tool execution — a Reader who somehow requests a destructive tool receives `403`

## Non-Goals

- Building the full web UI (separate feature — this spec covers the auth layer only)
- User management UI or self-service API key provisioning
- Fine-grained per-tool permissions beyond the Reader/Admin split
- External identity providers beyond Entra ID (Google, GitHub, etc.)
- Database-backed session storage (NextAuth.js JWT strategy is sufficient for v1)

## User Stories

1. **As an Entra ID user with the Admin role**, I can sign in via the web UI and invoke any agent tool, including destructive actions that require confirmation.
2. **As an Entra ID user with the Reader role**, I can sign in and investigate security incidents using read-only tools, but destructive tools are blocked with a clear error.
3. **As an API consumer with an Admin API key**, I can call `/api/agent` with a bearer token and invoke any tool.
4. **As an API consumer with a Reader API key**, I can call `/api/agent` with a bearer token and use read-only tools only.
5. **As a developer**, I can open a single permissions file to see and modify which roles have access to which tool categories.
6. **As an unauthenticated caller**, I receive a `401 Unauthorized` response on all protected routes.

## Proposed Architecture

### Authentication Providers

**Entra ID (OAuth/OIDC)**
- Configured as a NextAuth.js provider using the Microsoft Entra ID / Azure AD integration
- App roles (`Reader`, `Admin`) are defined in the Entra ID app registration and included in the ID token claims
- The NextAuth.js session/JWT callback maps the Entra ID app role claim to the internal role type

**API Key (Custom)**
- Implemented as a NextAuth.js Credentials provider or as a custom middleware layer that intercepts bearer tokens before NextAuth.js session resolution
- API keys are stored in a configuration source (environment variables or a config file for v1) with an associated role
- Each API key entry maps to a role: `{ key: string, role: "admin" | "reader", label: string }`

### Permission Model

A single library file (e.g., `web/lib/permissions.ts`) serves as the source of truth:

- Defines the `Role` type (`"admin" | "reader"`)
- Defines which tool categories each role can access, referencing the existing `DESTRUCTIVE_TOOLS` set from `web/lib/tools.ts`
- Exports a function like `canUseTool(role, toolName)` that returns `boolean`
- Exports a function like `getAllowedTools(role)` that returns the filtered tool list for a given role
- Both Entra ID sessions and API key sessions resolve to the same `Role` type, so the permission check is identity-provider-agnostic

### Route Protection

- All `/api/agent/*` routes check for a valid session (NextAuth.js) or valid API key (bearer token) before processing
- The agent loop integration checks `canUseTool(role, toolName)` before executing any tool — if a destructive tool is requested by a Reader, it returns an error result to Claude instead of executing
- The confirmation endpoint (`/api/agent/confirm`) also verifies the caller's role permits the pending tool

### Session Strategy

- NextAuth.js JWT strategy (stateless, no database required)
- The JWT contains the user's role, display name, and provider type
- API key requests are stateless — the key is validated on each request and the role is resolved inline

## Open Questions

- Should API keys be stored in environment variables, a JSON config file, or a simple key-value store? Environment variables are simplest for v1 but may not scale. a JSON config file to start, will migrate to Azure Key Vault in the future.
- Should the Reader role see destructive tools in the tool list returned to Claude (with execution blocked), or should destructive tools be omitted from the schema entirely for Reader sessions? Omitting them prevents Claude from even attempting destructive actions. Omit them enitrely.
- Should there be a rate limit difference between Admin and Reader roles? yes double the rate limit for admins. I would like a file in lib where I can easily configure rate limits per role.
- Should API key authentication go through NextAuth.js Credentials provider or be handled as separate middleware before NextAuth.js? Have it go through next auth

## Success Criteria

- [ ] Entra ID users can sign in and their app role (`Admin` or `Reader`) is correctly mapped to the internal role
- [ ] API key holders can authenticate via bearer token and their role is resolved
- [ ] Unauthenticated requests to `/api/agent/*` return `401`
- [ ] Reader role cannot execute destructive tools — receives `403` or an error event in the NDJSON stream
- [ ] Admin role can execute all tools including destructive ones
- [ ] A single `permissions.ts` file controls role-to-tool mappings for both auth methods
- [ ] Existing mock mode and CLI remain unaffected
