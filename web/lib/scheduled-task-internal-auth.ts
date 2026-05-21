// ─────────────────────────────────────────────────────────────
//  Internal-poll authentication
//
//  Verifies inbound Bearer tokens on
//  POST /api/internal/scheduled-tasks/poll. The expected caller is
//  the scheduledTaskPoller Azure Function authenticated via its
//  system-assigned Managed Identity. The token's `oid` claim must
//  match SCHEDULED_TASK_POLLER_MI_OID. Issuer + audience + tenant
//  are also pinned.
//
//  Dev-bypass: set SCHEDULED_TASK_POLLER_DEV_BYPASS=true outside of
//  production to skip verification (useful for local testing of the
//  poll endpoint with curl).
// ─────────────────────────────────────────────────────────────

import { createRemoteJWKSet, jwtVerify } from "jose";

import { logger } from "./logger";

const SCHEDULED_TASK_POLLER_MI_OID = process.env.SCHEDULED_TASK_POLLER_MI_OID;
const SCHEDULED_TASK_POLLER_AUDIENCE = process.env.SCHEDULED_TASK_POLLER_AUDIENCE;
// Affirmative check (=== "development") matches DEV_AUTH_BYPASS's posture in
// auth-helpers.ts. The mirroring startup guard in config.ts aborts boot if
// SCHEDULED_TASK_POLLER_DEV_BYPASS is set with NODE_ENV !== "development".
const SCHEDULED_TASK_POLLER_DEV_BYPASS =
  process.env.SCHEDULED_TASK_POLLER_DEV_BYPASS === "true" &&
  process.env.NODE_ENV === "development";
const ENTRA_TENANT_ID = process.env.AZURE_TENANT_ID;

const jwks = ENTRA_TENANT_ID
  ? createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`),
    )
  : null;

const ISSUER_V1 = ENTRA_TENANT_ID
  ? `https://sts.windows.net/${ENTRA_TENANT_ID}/`
  : undefined;
const ISSUER_V2 = ENTRA_TENANT_ID
  ? `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`
  : undefined;

export interface InternalAuthResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export async function verifyInternalPollRequest(
  authorizationHeader: string | null,
): Promise<InternalAuthResult> {
  if (SCHEDULED_TASK_POLLER_DEV_BYPASS) {
    // Escalated to error: a production deployment that reaches this branch
    // has misconfigured both env vars AND the startup guard somehow let it
    // through. The endpoint runs the agent loop with admin role on every
    // task, so loud telemetry matters.
    logger.error(
      "scheduled_task.internal_auth_dev_bypass",
      "scheduled-task-internal-auth",
    );
    return { ok: true };
  }

  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, reason: "missing_bearer" };
  }
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, status: 401, reason: "empty_bearer" };
  }

  if (!jwks || !SCHEDULED_TASK_POLLER_AUDIENCE || !SCHEDULED_TASK_POLLER_MI_OID || !ENTRA_TENANT_ID) {
    return {
      ok: false,
      status: 503,
      reason: "internal_auth_not_configured",
    };
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: SCHEDULED_TASK_POLLER_AUDIENCE,
      issuer: [ISSUER_V1, ISSUER_V2].filter((x): x is string => Boolean(x)),
    });

    if (payload.tid !== ENTRA_TENANT_ID) {
      return { ok: false, status: 401, reason: "wrong_tenant" };
    }
    if (payload.oid !== SCHEDULED_TASK_POLLER_MI_OID) {
      return { ok: false, status: 403, reason: "wrong_principal" };
    }

    return { ok: true };
  } catch (err) {
    logger.warn(
      "scheduled_task.internal_auth_failed",
      "scheduled-task-internal-auth",
      { errorMessage: (err as Error).message },
    );
    return { ok: false, status: 401, reason: "invalid_token" };
  }
}
