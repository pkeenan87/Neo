# Spec for Custom Domain Setup

branch: claude/feature/custom-domain-setup

## Summary

Add a custom internal domain (e.g., `neo.internal.contoso.com`) to the existing Azure App Service deployment while preserving the default `*.azurewebsites.net` domain. Both domains should resolve to the same application, ensuring zero downtime for existing users during and after the transition.

## Functional Requirements

- Configure a custom domain binding on the Azure App Service so the app is reachable via both the new internal domain and the existing `*.azurewebsites.net` domain
- Provision and bind a TLS/SSL certificate for the custom domain (managed certificate or upload existing internal CA cert)
- Create the required DNS records (CNAME or A + TXT verification) for the custom domain pointing to the App Service
- Ensure the existing `*.azurewebsites.net` domain remains fully functional — no redirect, no removal
- Validate that authentication flows (Azure AD / Entra ID) work correctly on both domains (redirect URIs, CORS, token audiences)
- Update any hard-coded or environment-variable-based URLs (e.g., `NEO_SERVER_URL`, OAuth redirect URIs) to support both domains
- Ensure CORS policies accept requests from both origins

## Possible Edge Cases

- Azure AD app registration may need multiple redirect URIs (one per domain) — verify both are registered
- If the custom domain uses an internal DNS zone (not publicly resolvable), Azure managed certificates won't work — an internally-signed or uploaded certificate is required
- Cookie domain scope may need adjustment if the custom domain is on a different TLD than `azurewebsites.net`
- Health probes or monitoring pointing at the old domain should continue to work
- If the app uses absolute URLs in responses (e.g., API links, WebSocket endpoints), these may need to be origin-aware or configurable
- Rate limiting or WAF rules tied to the `azurewebsites.net` hostname may need to be duplicated for the new domain

## Acceptance Criteria

- The application is accessible and fully functional via the new custom internal domain over HTTPS
- The application remains accessible and fully functional via the existing `*.azurewebsites.net` domain over HTTPS
- Authentication (login, token refresh) works on both domains without errors
- API calls from both the CLI (`NEO_SERVER_URL`) and web UI work against either domain
- TLS certificate is valid and trusted by internal clients for the custom domain
- DNS resolution for the custom domain returns the correct App Service IP / CNAME
- No existing users experience downtime or breakage during the rollout

## Open Questions

- What is the desired custom domain name (e.g., `neo.yourcompany.com`, `neo.internal.contoso.com`)? neo.companyname.com
- Is the custom domain on a public DNS zone or an internal/private DNS zone? internal
- Should the `azurewebsites.net` domain eventually be disabled, or kept permanently as a fallback? keep as fallback
- Is there an existing internal CA or certificate to use, or should Azure managed certificates be provisioned? I already have the certificates created and working
- Are there any network restrictions (e.g., VNet integration, private endpoints) that affect DNS resolution for the custom domain? it only works from internal. I have network access cut off from external from everything except the teams bot which is the primary reason why I want to keep the azurewebsites.net domain
- Should the app detect which domain the user arrived on and adjust behavior (e.g., branding, redirects)? no

## Testing Guidelines

Create test file(s) in the `./test` folder for the new feature, and create meaningful tests for the following cases, without going too heavy:

- Verify that environment config supports multiple allowed origins / base URLs
- Verify that CORS middleware accepts requests from both the custom domain and the `azurewebsites.net` domain
- Verify that OAuth redirect URI configuration includes both domains
- Verify that any URL-building logic in the app respects the incoming `Host` header or configured base URL rather than a hard-coded domain
