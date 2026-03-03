# Configuration Guide

This guide covers all configuration options for the Neo web server and CLI client.

## Table of Contents

- [Web Server Configuration](#web-server-configuration)
  - [Environment Variables](#environment-variables)
  - [API Key Management](#api-key-management)
  - [Entra ID Setup (Web Server)](#entra-id-setup-web-server)
  - [Mock Mode](#mock-mode)
- [CLI Configuration](#cli-configuration)
  - [Config File](#config-file)
  - [Authentication Priority](#authentication-priority)
  - [API Key Auth (CLI)](#api-key-auth-cli)
  - [Entra ID Auth (CLI)](#entra-id-auth-cli)
  - [Server URL](#server-url)
  - [Environment Variables (CLI)](#environment-variables-cli)
- [Azure App Registration](#azure-app-registration)
  - [Server App Registration](#server-app-registration)
  - [CLI Public Client Setup](#cli-public-client-setup)
- [Security Notes](#security-notes)

---

## Web Server Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Mock mode (default: true)
# Set to false and add Azure credentials for live API calls
MOCK_MODE=true

# Auth.js secret (generate with: openssl rand -hex 32)
AUTH_SECRET=<random-hex-string>

# Microsoft Entra ID (leave blank until app registration is configured)
AUTH_MICROSOFT_ENTRA_ID_ID=
AUTH_MICROSOFT_ENTRA_ID_SECRET=
AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0

# Azure credentials for tool execution (required when MOCK_MODE=false)
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_SUBSCRIPTION_ID=

# Sentinel workspace
SENTINEL_WORKSPACE_ID=
SENTINEL_WORKSPACE_NAME=
SENTINEL_RESOURCE_GROUP=
```

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `MOCK_MODE` | No | `true` (default) returns simulated data; `false` uses real Azure APIs |
| `AUTH_SECRET` | Yes | Random secret for Auth.js session encryption |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | No | Entra ID app registration client ID (for web login) |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | No | Entra ID app registration client secret (for web login) |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | No | Entra ID issuer URL |
| `AZURE_TENANT_ID` | When live | Azure tenant for tool execution |
| `AZURE_CLIENT_ID` | When live | Azure app registration for tool execution |
| `AZURE_CLIENT_SECRET` | When live | Azure app registration secret |
| `AZURE_SUBSCRIPTION_ID` | When live | Azure subscription ID |
| `SENTINEL_WORKSPACE_ID` | When live | Log Analytics workspace GUID |
| `SENTINEL_WORKSPACE_NAME` | When live | Log Analytics workspace name |
| `SENTINEL_RESOURCE_GROUP` | When live | Resource group containing the Sentinel workspace |

### API Key Management

API keys are stored in `web/api-keys.json`:

```json
{
  "keys": [
    {
      "key": "your-secret-api-key",
      "role": "admin",
      "label": "SOC Team Admin Key"
    },
    {
      "key": "another-secret-api-key",
      "role": "reader",
      "label": "Analyst Read-Only Key"
    }
  ]
}
```

Each key entry has:

| Field | Description |
|-------|-------------|
| `key` | The secret token. Generate with `openssl rand -base64 24`. |
| `role` | `admin` (full access) or `reader` (read-only tools only). |
| `label` | Human-readable name shown in logs and session ownership. |

An example file is provided at `web/api-keys.example.json`.

**Hot-reload**: The server watches `api-keys.json` for changes. You can add or remove keys without restarting the server.

**Security**: Keep `api-keys.json` out of version control. Add it to `.gitignore` if it contains production keys.

### Entra ID Setup (Web Server)

To enable Entra ID authentication on the web server (for browser-based access):

1. Register an application in the Azure portal (see [Azure App Registration](#azure-app-registration)).
2. Add a **Web** redirect URI: `http://localhost:3000/api/auth/callback/microsoft-entra-id` (adjust host for production).
3. Create a client secret.
4. Set the environment variables:
   ```bash
   AUTH_MICROSOFT_ENTRA_ID_ID=<client-id>
   AUTH_MICROSOFT_ENTRA_ID_SECRET=<client-secret>
   AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   ```

**Role mapping**: Users with the `Admin` app role in Entra ID get the `admin` role in Neo. All other users get `reader`.

### Mock Mode

When `MOCK_MODE=true` (the default), all tool calls return simulated data. This is useful for:

- Testing the CLI/web interface without Azure credentials
- Development and demo purposes
- CI/CD pipelines

Set `MOCK_MODE=false` and provide Azure credentials to execute real Sentinel queries, Defender actions, and Entra ID operations.

---

## CLI Configuration

### Config File

The CLI stores credentials at `~/.neo/config.json`. Sensitive values (API keys, tokens) are encrypted at rest using AES-256-GCM with a machine-derived key.

You should never need to edit this file manually. Use the `auth` commands instead:

```bash
node src/index.js auth login   # Configure credentials
node src/index.js auth logout  # Clear Entra ID credentials
node src/index.js auth status  # View current config
```

The config file is automatically created on first `auth login` with permissions `600` (owner read/write only). The `~/.neo/` directory is created with permissions `700`.

### Authentication Priority

The CLI resolves authentication in this order (first match wins):

1. `--api-key <key>` flag (dev-only — visible in process table)
2. `NEO_API_KEY` environment variable
3. Saved API key in `~/.neo/config.json`
4. Saved Entra ID tokens in `~/.neo/config.json`

### API Key Auth (CLI)

The simplest authentication method. Get an API key from your admin, then:

**Option A — Save to config (recommended)**:
```bash
node src/index.js auth login --api-key <your-key>
npm start
```

**Option B — Environment variable**:
```bash
export NEO_API_KEY=<your-key>
npm start
```

**Option C — Inline flag (dev-only)**:
```bash
npm start -- --api-key <your-key>
```

> Note: Option C exposes the key in the process table (`ps aux`). Use it only during local development.

### Entra ID Auth (CLI)

Browser-based login using OAuth2 Authorization Code with PKCE. No client secret required.

**Prerequisites**: Your admin must add `http://localhost:4000/callback` as a redirect URI under "Mobile and desktop applications" in the Entra ID app registration (see [CLI Public Client Setup](#cli-public-client-setup)).

**Login**:
```bash
node src/index.js auth login --tenant-id <tenant-id> --client-id <client-id>
```

This will:
1. Open your browser to the Microsoft login page.
2. Start a temporary local server on port 4000 for the callback.
3. Exchange the authorization code for tokens.
4. Save encrypted tokens to `~/.neo/config.json`.

After login, just run `npm start` — the CLI will use the saved tokens and refresh them automatically.

**Logout**:
```bash
node src/index.js auth logout
```

**Check status**:
```bash
node src/index.js auth status
```

You can also set tenant and client IDs via environment variables instead of flags:
```bash
export NEO_TENANT_ID=<tenant-id>
export NEO_CLIENT_ID=<client-id>
node src/index.js auth login
```

### Server URL

The CLI defaults to `http://localhost:3000`. Override it for remote servers:

**Option A — Save to config**:

Currently set via the config file at `~/.neo/config.json` or environment variable. The `auth login` commands use the default.

**Option B — Environment variable**:
```bash
export NEO_SERVER=https://neo.example.com
npm start
```

**Option C — Flag**:
```bash
npm start -- --server https://neo.example.com
```

**Security**: HTTPS is required for non-localhost URLs. The CLI will reject `http://` connections to remote hosts.

Priority: `--server` flag > `NEO_SERVER` env var > config file > `http://localhost:3000`

### Environment Variables (CLI)

| Variable | Description |
|----------|-------------|
| `NEO_SERVER` | Server URL (default: `http://localhost:3000`) |
| `NEO_API_KEY` | API key for authentication |
| `NEO_TENANT_ID` | Entra ID tenant ID |
| `NEO_CLIENT_ID` | Entra ID client/application ID |
| `DEBUG` | Set to any value to enable verbose error output |

---

## Azure App Registration

Neo uses two separate concerns in Azure AD:

1. **Server app registration** — used by the web server to authenticate users and call Azure APIs.
2. **Public client redirect** — added to the same app registration to allow CLI browser login.

### Server App Registration

1. Go to **Azure Portal > Microsoft Entra ID > App registrations > New registration**.
2. Name it (e.g., "Neo Security Agent").
3. Set **Supported account types** to "Accounts in this organizational directory only".
4. Under **Redirect URIs**, add a **Web** platform URI:
   ```
   http://localhost:3000/api/auth/callback/microsoft-entra-id
   ```
   For production, replace with your actual domain.
5. Go to **Certificates & secrets > New client secret**. Copy the value and set it as `AUTH_MICROSOFT_ENTRA_ID_SECRET`.
6. Copy the **Application (client) ID** and set it as `AUTH_MICROSOFT_ENTRA_ID_ID`.
7. Set the **Issuer** to `https://login.microsoftonline.com/<tenant-id>/v2.0`.

**App roles** (for RBAC):

1. Go to **App roles > Create app role**:
   - Display name: `Admin`
   - Value: `Admin`
   - Allowed member types: Users/Groups
2. Assign the `Admin` role to users or groups under **Enterprise applications > Neo Security Agent > Users and groups**.
3. Users without the `Admin` role automatically get `reader` permissions.

### CLI Public Client Setup

To enable Entra ID login from the CLI, add a public client redirect URI to the same app registration:

1. Go to **Azure Portal > App registrations > Neo Security Agent > Authentication**.
2. Click **Add a platform > Mobile and desktop applications**.
3. Enter the custom redirect URI:
   ```
   http://localhost:4000/callback
   ```
4. Under **Advanced settings**, set **Allow public client flows** to **Yes**.
5. Click **Save**.

No client secret is needed for the CLI — it uses PKCE (Proof Key for Code Exchange).

---

## Security Notes

- **API keys** are compared using timing-safe comparison to prevent enumeration attacks.
- **CLI credentials** are encrypted at rest using AES-256-GCM. The encryption key is derived from the local machine's username and hostname via scrypt with a random per-install salt. Credentials are not portable between machines.
- **HTTPS enforcement**: The CLI rejects plain HTTP connections to non-localhost servers.
- **Token refresh**: Entra ID tokens are refreshed automatically. If the refresh token expires, you will need to run `auth login` again.
- **File permissions**: `~/.neo/config.json` is created with `0600` (owner-only). The directory is `0700`.
- **Session ownership**: Each agent session is tied to the identity that created it. Only the owner or an admin can access or delete a session.
