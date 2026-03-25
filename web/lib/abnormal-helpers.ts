// ── Abnormal Security Pure Helpers ───────────────────────────
// Shared between executors.ts and tests. No I/O, no side effects.

const MD5_RE = /^[a-f0-9]{32}$/i;
const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ALLOWED_LINK_SCHEMES = new Set(["http:", "https:"]);
// Activity log IDs — allow UUIDs and prefixed UUIDs (e.g. "act-<uuid>")
const ACTIVITY_LOG_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateMd5Hash(hash: string): boolean {
  return MD5_RE.test(hash);
}

export function validateSenderEmail(email: string): boolean {
  return BASIC_EMAIL_RE.test(email);
}

export function validateSenderIp(ip: string): boolean {
  return IPV4_RE.test(ip);
}

export function validateBodyLink(link: string): boolean {
  try {
    const u = new URL(link);
    return ALLOWED_LINK_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

export function validateActivityLogId(id: string): boolean {
  return id.length > 0 && ACTIVITY_LOG_ID_RE.test(id);
}

export function defaultTimeRange(): { start_time: string; end_time: string } {
  const now = new Date();
  const start = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  return {
    start_time: start.toISOString(),
    end_time: now.toISOString(),
  };
}

export interface RemediateValidationInput {
  messages?: { message_id: string; recipient_email: string }[];
  remediate_all?: boolean;
  search_filters?: Record<string, unknown>;
}

export function validateRemediateInput(input: RemediateValidationInput): void {
  if (input.remediate_all) {
    if (!input.search_filters || Object.keys(input.search_filters).length === 0) {
      throw new Error("remediate_all requires search_filters to scope the remediation.");
    }
    return;
  }

  if (!input.messages || input.messages.length === 0) {
    throw new Error(
      "Either provide a non-empty messages array, or set remediate_all: true with search_filters.",
    );
  }
}
