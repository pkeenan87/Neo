# Custom Domain Setup

## Context

The Neo web app is deployed on Azure App Service at `*.azurewebsites.net`. Users need to access it via a custom internal domain (`neo.companyname.com`) while keeping the `azurewebsites.net` domain active as a fallback for the Teams bot (which needs external network access). The custom domain is on an internal DNS zone with certificates already provisioned. The app uses `AUTH_URL` as the single source of truth for OAuth callbacks, so a dual-domain setup requires changes to auth configuration, Entra ID app registration, and documentation — but minimal code changes since the app already avoids hardcoded domains.

---

## Key Design Decisions

- **`AUTH_URL` stays single-valued** — Auth.js uses `AUTH_URL` for the OAuth redirect URI. Since users will primarily access via the custom domain, `AUTH_URL` should point to `https://neo.companyname.com`. The `azurewebsites.net` domain is kept for the Teams bot (which uses Bot Framework JWT auth, not browser OAuth), so it doesn't need its own OAuth callback.
- **Entra ID app registration gets a second redirect URI** — Add `https://neo.companyname.com/api/auth/callback/microsoft-entra-id` alongside the existing `azurewebsites.net` callback. This ensures OAuth works if someone bookmarks or shares the old URL.
- **No CORS changes needed** — The app uses `connect-src 'self'` in CSP and compares `Origin` against `Host` for CSRF. Both are already domain-agnostic since `'self'` and the host comparison automatically match whichever domain the request arrives on.
- **Provisioning script approach** — Create an Azure CLI script to add the custom domain binding and upload the existing certificate, matching the project's existing pattern of provisioning scripts.
- **CLI `NEO_SERVER_URL` documentation update** — CLI users who currently point at `azurewebsites.net` should be told to switch to the custom domain (for internal access) or keep the current URL (for external/Teams access).

---

## Files to Change

| File | Change |
|------|--------|
| `web/auth.ts` | Add the `azurewebsites.net` callback URI as a second redirect URI so OAuth works from either domain |
| `web/app/downloads/page.tsx` | Update the example `NEO_SERVER_URL` from `neo.yourcompany.com` to reflect dual-domain guidance |
| `docs/configuration.md` | Add a "Custom Domain" section documenting the setup, DNS requirements, and dual-domain considerations |
| `docs/user-guide.md` | Update triage API URI examples to show both domain options |
| `infra/add-custom-domain.sh` (new) | Azure CLI provisioning script for custom domain binding + certificate upload |
| `test/custom-domain.test.js` (new) | Tests for dual-origin auth config and CSRF validation |

---

## Implementation Steps

### 1. Add dual redirect URI support in auth.ts

- In `web/auth.ts`, inside the `MicrosoftEntraID` provider's `authorization.params`, the `redirect_uri` is currently hardcoded to `${process.env.AUTH_URL}/api/auth/callback/microsoft-entra-id`
- Add a new environment variable `AUTH_URL_SECONDARY` (optional) for the secondary domain
- When `AUTH_URL_SECONDARY` is set, register it as an additional allowed callback URL
- Auth.js handles the redirect URI based on the incoming request's host, but the explicit `redirect_uri` in the authorization params forces a single value. Remove the explicit `redirect_uri` override and let Auth.js auto-detect from the incoming request host (Auth.js with `trustHost: true` already does this). Alternatively, keep the explicit URI but ensure Entra ID has both registered
- Test: verify OAuth login works from both domains

### 2. Register second redirect URI in Entra ID

- This is a manual Azure portal / CLI step, not a code change
- In the Entra ID app registration, under Authentication > Redirect URIs, add: `https://neo.companyname.com/api/auth/callback/microsoft-entra-id`
- Keep the existing `https://<app>.azurewebsites.net/api/auth/callback/microsoft-entra-id`
- Document this step in the provisioning script and docs

### 3. Create Azure CLI provisioning script

- Create `infra/add-custom-domain.sh` that:
  - Accepts parameters: resource group, app name, custom domain, certificate PFX path
  - Runs `az webapp config hostname add` to bind the custom domain
  - Runs `az webapp config ssl upload` to upload the PFX certificate
  - Runs `az webapp config ssl bind` to bind the certificate to the custom domain
  - Runs `az ad app update` to add the second redirect URI to the Entra ID app registration
  - Outputs the required internal DNS CNAME record (`neo.companyname.com` → `<app>.azurewebsites.net`)
  - Prints a verification checklist

### 4. Update environment variable documentation

- In `docs/configuration.md`, add a "Custom Domain Setup" section explaining:
  - How to set `AUTH_URL` to the primary (custom) domain
  - That `AUTH_URL_SECONDARY` is optional and only needed if OAuth must work from both domains
  - The Entra ID redirect URI registration requirement
  - DNS CNAME record requirement
  - That the `azurewebsites.net` domain remains functional without any configuration
- Update the environment variable table to include `AUTH_URL_SECONDARY`

### 5. Update downloads page and user-guide examples

- In `web/app/downloads/page.tsx` line 166, update the example `NEO_SERVER_URL` to show `https://neo.companyname.com` as the primary and note the `azurewebsites.net` alternative
- In `docs/user-guide.md` lines 967 and 1008, update triage API URI examples to show the custom domain as the primary with a note about the `azurewebsites.net` fallback

### 6. Write tests

- Create `test/custom-domain.test.js` with:
  - Test that `AUTH_URL` with a custom domain produces the correct OAuth redirect URI
  - Test that the CSRF origin-vs-host check in admin routes passes when origin and host match on either domain (this is already the behavior — test confirms it)
  - Test that CSP `connect-src 'self'` is domain-agnostic (verify the header value is literally `'self'`, not a hardcoded domain)

---

## Verification

1. Set `AUTH_URL=https://neo.companyname.com` in `.env` and confirm the app starts without warnings
2. Verify OAuth redirect URI resolves correctly for the custom domain
3. Confirm the `azurewebsites.net` domain still serves the app (no redirects, no blocks)
4. Confirm Teams bot routes (`/api/teams/*`) work from external via `azurewebsites.net`
5. Run the test suite: `cd web && npm test` (once tests are added)
6. Run the provisioning script in a staging environment and verify DNS + TLS + domain binding
