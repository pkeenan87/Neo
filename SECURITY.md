# Security policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in Neo, please **do not** open a public issue. Instead:

- Open a private security advisory at <https://github.com/pkeenan87/Neo/security/advisories/new>, or
- Email the maintainer directly with details and reproduction steps.

We aim to acknowledge new reports within **5 business days** and to provide a remediation plan within **15 business days** for High / Critical issues.

## Scope

This policy covers:

- The Next.js web application under `web/` (API routes, agent loop, tool dispatch, persistence, observability)
- The CLI under `cli/`
- Provisioning scripts under `scripts/`
- The Azure Function under `functions/csv-cleanup/`
- This repository's CI/CD and supply-chain controls (`.github/`)

## Out of scope

- Security of the third-party SaaS endpoints Neo calls (Microsoft Sentinel, Defender XDR, Microsoft Graph, Anthropic, ThreatLocker, Abnormal Security, Lansweeper, AppOmni, Azure AI Search). Report vulnerabilities in those products to their respective vendors.
- Misconfigurations of Azure resources provisioned by Neo's scripts in your tenant — those are your operational responsibility once deployed.
- Issues that depend on already-elevated access (e.g. an attacker who already has Azure AD admin can escalate further).

## Coordinated disclosure

We follow standard 90-day coordinated-disclosure practice and will work with reporters on a public-disclosure timeline once a fix has shipped to production.
