# Spec for Fix Auth.js PKCE Cookie Failure

branch: claude/fix/authjs-pkce-cookie-failure

## Summary

Production logs show repeated `InvalidCheck: pkceCodeVerifier value could not be parsed` errors from Auth.js. This is a well-known issue when Next Auth v5 runs behind Azure App Service's reverse proxy — the PKCE code verifier cookie set during the OAuth login flow is lost or cannot be read when the Entra ID callback returns. The root cause is that Auth.js defaults to cookie settings based on the `AUTH_URL` scheme, and when the proxy terminates TLS the cookie `Secure` flag and `SameSite` attribute can mismatch, causing the browser to drop the cookie between redirects.

## Functional requirements

- Add explicit cookie configuration in `web/auth.ts` for the `pkceCodeVerifier` cookie to ensure it survives the OAuth redirect cycle on Azure App Service
- Set `sameSite: "none"` and `secure: true` on the PKCE cookie so it is sent on the cross-origin redirect from Entra ID back to the app
- Also configure the `state` cookie with the same settings, since it has the same cross-origin redirect vulnerability
- Ensure `AUTH_URL` in the production deployment is set to the actual HTTPS production domain (not `http://localhost:3000`) — document this in `.env.example`
- Add a startup validation warning if `AUTH_URL` does not start with `https://` when `NODE_ENV=production`

## Possible Edge Cases

- Local development with `http://localhost` — `sameSite: "none"` requires `secure: true`, which doesn't work over plain HTTP. The cookie config should only be applied when `AUTH_URL` starts with `https://`, or use a conditional configuration
- Multiple App Service instances — `AUTH_SECRET` must be identical across all instances for cookie decryption. If it differs, all PKCE cookies fail. Add a note about this.
- Browser privacy settings — some browsers block third-party cookies with `sameSite: "none"`. This is standard OAuth behavior and not specific to this app.

## Acceptance Criteria

- The `InvalidCheck: pkceCodeVerifier value could not be parsed` error no longer appears in production logs
- Users can log in via Entra ID SSO without errors
- Local development login still works (cookies adapt to HTTP vs HTTPS)
- `.env.example` documents the `AUTH_URL` requirement for production

## Open Questions

- Is the production `AUTH_URL` currently set to the correct HTTPS domain, or is it still `http://localhost:3000`? Need to verify in Azure App Service app settings. correct domain
- Are there multiple App Service instances (scale-out) that could cause `AUTH_SECRET` mismatches? just one right now but would like to have multiple in the future.

## Testing Guidelines

- No automated tests needed — this is a cookie configuration change that can only be verified in a deployed environment with real Entra ID login
- Manual verification: deploy to App Service, attempt Entra ID login, confirm no PKCE errors in logs
