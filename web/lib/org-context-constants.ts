// Shared constants for organizational context limits.
// Imported by config.ts (server), the admin API route, and the settings UI component.
//
// MAX = 100K chars (~25K tokens). The active storage tier is Azure Blob
// (`org-context-blob-store.ts`); the Key Vault and env-var paths remain as
// fallbacks for legacy small deployments. Key Vault's underlying value cap
// (~25 KB) means values above ~25,000 chars must be stored in blob — the
// admin route refuses Key Vault writes that exceed that threshold.
// WARN = 20K chars: every saved character is injected into the system
// prompt on every turn (cached after the first call, but uncached input is
// non-trivial), so we surface a warning when the context approaches the
// "large enough to notice" band.
export const ORG_CONTEXT_MAX_CHARS = 100_000;
export const ORG_CONTEXT_WARN_CHARS = 20_000;
// Hard cap for the Key Vault fallback tier — Azure Key Vault secret values
// max out at 25 KB. The admin route uses this to refuse writes that would
// silently fail when sent to setSecret().
export const ORG_CONTEXT_KV_MAX_CHARS = 25_000;
