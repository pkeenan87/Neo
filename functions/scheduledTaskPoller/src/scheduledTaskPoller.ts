import { app, type InvocationContext, type Timer } from "@azure/functions";

// ── Configuration ────────────────────────────────────────────
// Read from Function App settings. The Function runs under its
// system-assigned Managed Identity; the Web App's
// SCHEDULED_TASK_POLLER_MI_OID must equal this MI's principal id
// (object id) for the internal /poll endpoint to accept the call.

interface Config {
  neoWebUrl: string;
  neoWebAudience: string;
}

function loadConfig(): Config {
  const neoWebUrl = process.env.NEO_WEB_URL;
  const neoWebAudience = process.env.NEO_WEB_AUDIENCE;
  if (!neoWebUrl) throw new Error("NEO_WEB_URL is not configured");
  if (!neoWebAudience) throw new Error("NEO_WEB_AUDIENCE is not configured");
  return { neoWebUrl: neoWebUrl.replace(/\/$/, ""), neoWebAudience };
}

// ── Managed Identity ─────────────────────────────────────────

interface AppServiceMiResponse {
  access_token?: string;
  expires_on?: string;
  resource?: string;
  token_type?: string;
}

/**
 * Acquire an AAD token via the App Service Managed Identity endpoint.
 *
 * Uses the v2019-08-01 protocol Azure documents at
 * https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity?tabs=portal%2Chttp
 *
 * Returns the access token on success, or null on failure (the
 * specific failure is already logged via context.error).
 *
 * We bypass @azure/identity because its 4.13.x parser has been
 * observed throwing a generic "Response had no 'expiresOn' property"
 * error on this exact endpoint without exposing the raw response body
 * for diagnosis. Direct fetch keeps the wire-format visibility.
 */
async function acquireAppServiceMiToken(
  audience: string,
  context: InvocationContext,
): Promise<string | null> {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) {
    context.error(
      `Managed Identity env vars missing — IDENTITY_ENDPOINT present: ${!!endpoint}, IDENTITY_HEADER present: ${!!header}. ` +
        "Confirm Function App → Settings → Identity → System assigned → Status is On.",
    );
    return null;
  }

  const url = `${endpoint}?resource=${encodeURIComponent(audience)}&api-version=2019-08-01`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-IDENTITY-HEADER": header },
    });
  } catch (err) {
    context.error(`MI endpoint fetch threw: ${(err as Error).message}`);
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    // Truncate to 1KB so a Front Door / WAF error page doesn't blow
    // up the log entry.
    const trimmed = text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
    context.error(`MI endpoint returned ${res.status}: ${trimmed}`);
    return null;
  }

  let body: AppServiceMiResponse;
  try {
    body = JSON.parse(text) as AppServiceMiResponse;
  } catch {
    const trimmed = text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
    context.error(`MI endpoint returned non-JSON ${res.status}: ${trimmed}`);
    return null;
  }

  if (!body.access_token) {
    // Log the keys we DID get back so we can see what the endpoint
    // actually returned. Never log the token value itself.
    const keys = Object.keys(body).join(",");
    context.error(`MI endpoint response missing access_token. Response keys: [${keys}]`);
    return null;
  }

  return body.access_token;
}

// ── Handler ──────────────────────────────────────────────────

async function scheduledTaskPollerHandler(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    context.error(`Configuration error: ${(err as Error).message}`);
    return;
  }

  // Talk to the App Service Managed Identity endpoint directly
  // instead of via @azure/identity. The SDK (v4.13.x — latest
  // stable as of 2026-06) has been observed in production to fail
  // with "Response had no 'expiresOn' property" when the upstream
  // returns a slightly different shape, with no path to see the
  // raw body. Direct fetch costs us ~15 lines of code and gives us
  // full visibility into the response. Protocol reference:
  // https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity?tabs=portal%2Chttp
  const token = await acquireAppServiceMiToken(config.neoWebAudience, context);
  if (!token) return;

  const url = `${config.neoWebUrl}/api/internal/scheduled-tasks/poll`;
  const startMs = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    const durationMs = Date.now() - startMs;
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — leave as text for the log
    }

    if (!res.ok) {
      context.error(
        `Poll request failed (${res.status}, ${durationMs}ms): ${typeof body === "string" ? body : JSON.stringify(body)}`,
      );
      return;
    }

    context.log(
      `Poll cycle ok (${durationMs}ms): ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  } catch (err) {
    context.error(`Poll request threw: ${(err as Error).message}`);
  }
}

// ── Registration ─────────────────────────────────────────────

app.timer("scheduledTaskPoller", {
  // Every 2 minutes. 6-field NCrontab (sec min hr day mon dow).
  schedule: "0 */2 * * * *",
  handler: scheduledTaskPollerHandler,
});
