import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ─────────────────────────────────────────────────────────────
//  RFC 1918 IPv4 ranges + loopback
// ─────────────────────────────────────────────────────────────

function parseIPv4(ip: string): number | null {
  // Strip IPv6-mapped prefix (::ffff:x.x.x.x)
  const stripped = ip.replace(/^::ffff:/, "");
  const parts = stripped.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  return num >>> 0; // unsigned 32-bit
}

interface CidrRange {
  network: number;
  mask: number;
}

function parseCidr(cidr: string): CidrRange | null {
  const [ip, bits] = cidr.split("/");
  const network = parseIPv4(ip);
  if (network === null) return null;
  const prefix = Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  // JS bitwise shifts are mod-32, so `~0 << 32` wrongly equals `~0 << 0`.
  // Guard the zero case explicitly.
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { network: (network & mask) >>> 0, mask };
}

// Inputs are hardcoded RFC 1918 literals — parseCidr cannot return null for them.
const INTERNAL_CIDRS: CidrRange[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
].map((c) => parseCidr(c)!);

// ─────────────────────────────────────────────────────────────
//  IPv6 internal addresses
// ─────────────────────────────────────────────────────────────

const IPV6_INTERNAL_PATTERNS: RegExp[] = [
  /^::1$/,               // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,    // ULA fc00::/7 (fc00::)
  /^fd[0-9a-f]{2}:/i,    // ULA fc00::/7 (fd00::)
  /^fe80:/i,              // Link-local fe80::/10
];

// ─────────────────────────────────────────────────────────────
//  Combined internal IP check (IPv4 + IPv6)
// ─────────────────────────────────────────────────────────────

function isInternalIP(ip: string): boolean {
  // Try IPv4 first (also handles ::ffff:x.x.x.x mapped addresses)
  const num = parseIPv4(ip);
  if (num !== null) {
    return INTERNAL_CIDRS.some((r) => ((num & r.mask) >>> 0) === r.network);
  }

  // IPv6 internal ranges
  return IPV6_INTERNAL_PATTERNS.some((re) => re.test(ip));
}

/**
 * Extract the client IP from request headers.
 *
 * Azure App Service (and most PaaS hosts) append the true client IP as the
 * LAST entry in x-forwarded-for. The leftmost entries are client-controlled
 * and must never be trusted. We always use the rightmost value.
 *
 * Falls back to x-real-ip if x-forwarded-for is absent.
 */
function resolveClientIP(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim());
    return ips[ips.length - 1];
  }
  return request.headers.get("x-real-ip") ?? "";
}

// ─────────────────────────────────────────────────────────────
//  Proxy (replaces deprecated middleware convention)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  Allowed hosts (defense-in-depth against Host header injection)
// ─────────────────────────────────────────────────────────────

const ALLOWED_HOSTS: Set<string> = new Set([
  "neo.companyname.com",
  "app-neo-prod-001.azurewebsites.net",
  "localhost",
  "localhost:3000",
]);

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isDev = process.env.NODE_ENV === "development";

  // ── Host allowlist (skip in dev to allow any localhost port) ──
  if (!isDev) {
    const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
    if (!ALLOWED_HOSTS.has(host)) {
      return new NextResponse("Bad Request", { status: 400 });
    }
  }

  // ── IP restriction for non-Teams API routes (production only) ──
  // /api/teams/* is exempted because those routes validate Bot Framework
  // JWTs at the handler level (botbuilder SDK). Any new route added under
  // /api/teams/ MUST perform its own authentication — there is no proxy
  // safety net for that prefix.
  if (!isDev && path.startsWith("/api/") && !path.startsWith("/api/teams/")) {
    const ip = resolveClientIP(request);

    if (!ip) {
      console.warn("[proxy] No source IP available, blocking request to", path);
      return new NextResponse("Forbidden", { status: 403 });
    }

    if (!isInternalIP(ip)) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // ── CSP headers ──
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // Next.js emits many inline scripts (hydration, chunk-loading, etc.) that
  // cannot receive nonces. For this internal SOC tool 'unsafe-inline' is
  // acceptable and avoids a cascade of CSP violations at page load.
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  // Next.js injects inline styles that cannot receive nonces.
  // 'unsafe-inline' is ignored by browsers when a nonce is present for
  // script-src, but for style-src it acts as the necessary fallback.
  const styleSrc = isDev
    ? "style-src 'self' 'unsafe-inline'"
    : `style-src 'self' 'unsafe-inline'`;

  const csp = [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export default proxy;

export const config = {
  matcher: [
    // Match all routes except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|neo-icon.png).*)",
  ],
};
