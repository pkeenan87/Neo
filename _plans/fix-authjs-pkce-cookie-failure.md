# Fix Auth.js PKCE Cookie Failure

## Context

Production logs show repeated `InvalidCheck: pkceCodeVerifier value could not be parsed` errors. The PKCE code verifier cookie set during the Entra ID login flow is lost during the OAuth redirect cycle on Azure App Service. Auth.js derives cookie settings from `AUTH_URL`, but behind the App Service reverse proxy the default `sameSite: "lax"` causes the cookie to be dropped on the cross-origin redirect from Entra ID back to the app. The fix is explicit cookie configuration in `web/auth.ts` that forces `sameSite: "none"` + `secure: true` for HTTPS deployments, ensuring the cookie survives the redirect.

---

## Key Design Decisions

- **Conditional cookie config based on AUTH_URL scheme** — only apply `sameSite: "none"` + `secure: true` when `AUTH_URL` starts with `https://`. Local dev over HTTP keeps the default `lax` behavior so login works on `localhost`.
- **Configure both `pkceCodeVerifier` and `state` cookies** — both are used in the OAuth redirect flow and both are vulnerable to the same proxy issue.
- **Use `__Secure-` prefix for HTTPS** — matches the Auth.js convention for secure cookies.
- **Add startup warning** — `validateConfig()` warns if `AUTH_URL` doesn't start with `https://` outside of development, since this is the most common misconfiguration causing PKCE failures.
- **Document AUTH_SECRET requirement** — note in `.env.example` that AUTH_SECRET must be identical across all instances for multi-instance deployments.

---

## Files to Change

| File | Change |
|------|--------|
| `web/auth.ts` | Add `cookies` configuration to the NextAuth options for `pkceCodeVerifier` and `state` cookies, conditional on HTTPS |
| `web/lib/config.ts` | Add startup warning in `validateConfig()` if `AUTH_URL` is not HTTPS in production |
| `.env.example` | Add note about AUTH_URL needing HTTPS in production and AUTH_SECRET consistency for multi-instance |

---

## Implementation Steps

### 1. Add cookie configuration in `web/auth.ts`

- Before the `NextAuth({...})` call, determine if the deployment uses HTTPS by checking if `process.env.AUTH_URL` starts with `"https://"`
- If HTTPS, add a `cookies` object to the NextAuth config with explicit settings for two cookies:
  - `pkceCodeVerifier`: name `__Secure-authjs.pkce.code_verifier`, options `{ httpOnly: true, sameSite: "none", path: "/", secure: true, maxAge: 900 }`
  - `state`: name `__Secure-authjs.state`, options `{ httpOnly: true, sameSite: "none", path: "/", secure: true, maxAge: 900 }`
- If not HTTPS (local dev), omit the `cookies` property entirely so Auth.js uses its defaults (`sameSite: "lax"`, `secure: false`)
- Place the conditional cookie config as a variable before the `NextAuth()` call and spread it into the config object

### 2. Add AUTH_URL validation in `web/lib/config.ts`

- In `validateConfig()`, after the existing `AUTH_SECRET` check, add a warning if `AUTH_URL` is set but does not start with `https://` and `NODE_ENV` is not `development`
- The warning should say: "AUTH_URL is not HTTPS — Auth.js cookies may fail on Azure App Service. Set AUTH_URL to your production HTTPS domain."

### 3. Update `.env.example`

- Update the `AUTH_URL` comment to emphasize it must be the actual HTTPS production domain when deployed
- Add a note under `AUTH_SECRET` that it must be identical across all App Service instances in scale-out deployments

---

## Verification

1. Run `cd web && npx next build` — build succeeds
2. Deploy to Azure App Service with correct `AUTH_URL=https://...` and `AUTH_SECRET`
3. Attempt Entra ID login — confirm no `InvalidCheck: pkceCodeVerifier` errors in logs
4. Test local dev with `AUTH_URL=http://localhost:3000` — confirm login still works
5. Check startup logs for the AUTH_URL warning if misconfigured
