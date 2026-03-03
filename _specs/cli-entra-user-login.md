# CLI Entra ID Login for Regular Users

> Make the CLI's Entra ID authentication work out-of-the-box for regular users without requiring them to know or provide an app registration client ID.

## Problem

The current `auth login` command requires two flags: `--tenant-id` and `--client-id`. The `--client-id` refers to an Entra ID app registration that must have public client redirect URIs configured. Regular users (SOC analysts, incident responders) don't know their organization's app registration client ID and shouldn't have to. This creates friction and makes the CLI feel like a developer tool rather than an analyst tool.

By contrast, tools like `az login` work with just a tenant ID (or nothing at all) because they ship with a well-known client ID baked in.

## Goals

- Allow `auth login` to work with only `--tenant-id` (or no flags at all if a tenant ID is already saved)
- Ship a sensible default client ID that the admin configures once and the CLI embeds, so regular users never need to provide it
- Support an admin-managed configuration model: admins set up the app registration once and distribute either (a) a default config or (b) simple instructions like "run `neo auth login`"
- Preserve backward compatibility — users who already pass `--client-id` should still work- DO not preserve backwards compatibility

## Non-Goals

- Removing API key authentication (it remains a parallel option)
- Changing the OAuth2 PKCE flow itself (the browser redirect mechanism stays the same)
- Adding multi-tenant support (the CLI targets a single organization's tenant)
- Modifying the web server's authentication system

## User Stories

1. **As a SOC analyst**, I can run `node src/index.js auth login` with no flags and be prompted to log in via my browser, because my admin has pre-configured the tenant and client IDs.
2. **As a SOC analyst on first setup**, I can run `node src/index.js auth login --tenant-id <id>` and the CLI uses the embedded default client ID, so I only need one piece of information from my admin.
3. **As an admin setting up Neo for my team**, I can configure the app registration client ID as a default in a shared config or environment variable so analysts don't need to know it.
4. **As a power user**, I can still pass `--client-id` explicitly to override the default if my organization uses a different app registration.

## Design Considerations

### Default Client ID Strategy

The CLI needs a default client ID that works without user input. Options to consider:

- **Embed in the codebase**: Hardcode the app registration client ID as a constant in the CLI source. Admins update it when they deploy or fork the tool. Simple but requires a code change per organization.
- **Server-provided discovery**: The CLI fetches the client ID and tenant ID from a well-known endpoint on the Neo server (e.g. `GET /api/auth/config`). This is the most user-friendly option — if the user has already configured a server URL, `auth login` can auto-discover everything.
- **Environment variable with fallback**: `NEO_CLIENT_ID` env var or config file value, with a clear error message if neither is set and no `--client-id` flag is provided.

The server-provided discovery approach is preferred because it centralizes configuration: the admin sets up the server once and every CLI user benefits automatically.

### Login Flow Simplification

With defaults in place, the ideal login experience becomes:

```
$ node src/index.js auth login
Opening browser for Entra ID login...
Logged in as jsmith@contoso.com. You can now run: npm start
```

No flags needed. The CLI resolves tenant ID and client ID from the server's discovery endpoint, falling back to saved config, then environment variables, then CLI flags.

### Priority Chain for Client ID and Tenant ID

1. Explicit CLI flags (`--tenant-id`, `--client-id`)
2. Environment variables (`NEO_TENANT_ID`, `NEO_CLIENT_ID`)
3. Saved values in `~/.neo/config.json`
4. Server-provided discovery endpoint

### Discovery Endpoint

A new unauthenticated endpoint on the web server that returns the Entra ID configuration needed for CLI login. This endpoint exposes only non-secret values (tenant ID and client ID are public identifiers, not secrets).

## Validation

- A new user with only a server URL configured can run `auth login` with no flags and complete the Entra ID login flow
- A user who passes `--tenant-id` and/or `--client-id` explicitly has those values take priority over defaults
- The discovery endpoint returns the correct tenant ID and client ID from the server's environment
- If no defaults can be resolved (no server, no env vars, no saved config), the CLI prints a clear error message explaining what to configure
- Existing `--client-id` / `--tenant-id` usage is not broken
