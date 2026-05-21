import { app, type InvocationContext, type Timer } from "@azure/functions";
import { ManagedIdentityCredential } from "@azure/identity";

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

  const credential = new ManagedIdentityCredential();
  let token: string;
  try {
    const result = await credential.getToken(`${config.neoWebAudience}/.default`);
    if (!result?.token) throw new Error("Token endpoint returned empty token");
    token = result.token;
  } catch (err) {
    context.error(`Failed to acquire MI token: ${(err as Error).message}`);
    return;
  }

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
