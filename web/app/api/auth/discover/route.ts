import { NextResponse } from "next/server";
// Import config to ensure dotenv loads .env from the project root
import "@/lib/config";

/**
 * Unauthenticated discovery endpoint for CLI Entra ID login.
 *
 * Returns the tenant ID and client ID so CLI users can log in
 * without needing to know the app registration details.
 */
export async function GET() {
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;

  if (!issuer || !clientId) {
    return NextResponse.json(
      { error: "Entra ID not configured on this server" },
      { status: 503 }
    );
  }

  // Extract tenant ID from issuer URL: https://login.microsoftonline.com/<tenant-id>/v2.0
  let tenantId: string | null = null;
  try {
    const segments = new URL(issuer).pathname.split("/").filter(Boolean);
    if (segments.length >= 1) {
      tenantId = segments[0];
    }
  } catch {
    // malformed issuer URL
  }

  if (!tenantId) {
    return NextResponse.json(
      { error: "Entra ID issuer URL is misconfigured" },
      { status: 503 }
    );
  }

  return NextResponse.json(
    { tenantId, clientId },
    { headers: { "Cache-Control": "private, max-age=3600" } }
  );
}
