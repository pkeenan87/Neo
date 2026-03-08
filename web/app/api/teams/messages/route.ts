import { Readable } from "stream";
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ActivityTypes,
  CardFactory,
  type TurnContext,
  type Attachment,
} from "botbuilder";
import { env } from "@/lib/config";
import { sessionStore } from "@/lib/session-factory";
import { runAgentLoop, resumeAfterConfirmation } from "@/lib/agent";
import { canUseTool } from "@/lib/permissions";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { logger, hashPii } from "@/lib/logger";
import {
  getSessionId,
  setSessionId,
} from "@/lib/teams-session-map";
import type { PendingTool, AgentLoopResult } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
//  Bot Framework adapter (lazy singleton — avoids assertions
//  during build when env vars are not yet set)
// ─────────────────────────────────────────────────────────────

let _adapter: CloudAdapter | null = null;

function getAdapter(): CloudAdapter {
  if (!_adapter) {
    const appId = env.MICROSOFT_APP_ID;
    const appPassword = env.MICROSOFT_APP_PASSWORD;
    const tenantId = env.AZURE_TENANT_ID;

    if (!appId || !appPassword) {
      throw new Error(
        "MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD must be set to use the Teams bot."
      );
    }

    const botAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: appId,
      MicrosoftAppPassword: appPassword,
      MicrosoftAppType: tenantId ? "SingleTenant" : "MultiTenant",
      ...(tenantId ? { MicrosoftAppTenantId: tenantId } : {}),
    });

    _adapter = new CloudAdapter(botAuth);
  }
  return _adapter;
}

// ─────────────────────────────────────────────────────────────
//  Adaptive Card builder for confirmation prompts
// ─────────────────────────────────────────────────────────────

/** Convert camelCase/snake_case keys to human-readable labels for FactSet. */
function toReadableLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildConfirmationCard(tool: PendingTool, sessionId: string): Attachment {
  const facts = Object.entries(tool.input)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ({ title: toReadableLabel(k), value: String(v) }));

  return CardFactory.adaptiveCard({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    fallbackText: `Confirmation Required: ${tool.name}. This action requires your explicit approval. Reply in the chat to confirm or cancel.`,
    body: [
      {
        type: "TextBlock",
        text: `Confirmation Required: ${tool.name}`,
        weight: "Bolder",
        size: "Medium",
        color: "Attention",
      },
      {
        type: "TextBlock",
        text: "This action requires your explicit approval before execution.",
        wrap: true,
      },
      {
        type: "FactSet",
        facts,
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: `Confirm: ${tool.name}`,
        style: "destructive",
        data: {
          action: "confirm",
          neoSessionId: sessionId,
          toolId: tool.id,
        },
      },
      {
        type: "Action.Submit",
        title: "Cancel",
        data: {
          action: "cancel",
          neoSessionId: sessionId,
          toolId: tool.id,
        },
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────
//  Send agent result back to the Teams conversation
// ─────────────────────────────────────────────────────────────

async function sendAgentResult(
  context: TurnContext,
  result: AgentLoopResult,
  sessionId: string
): Promise<void> {
  if (result.type === "confirmation_required") {
    await sessionStore.setPendingConfirmation(sessionId, result.tool);
    const card = buildConfirmationCard(result.tool, sessionId);
    await context.sendActivity({ attachments: [card] });
  } else {
    // Split long messages (Teams has a ~28 KB limit per message)
    const MAX_LEN = 20_000;
    const text = result.text;
    if (text.length <= MAX_LEN) {
      await context.sendActivity(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LEN) {
        await context.sendActivity(text.slice(i, i + MAX_LEN));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Turn handler
// ─────────────────────────────────────────────────────────────

async function handleTurn(context: TurnContext): Promise<void> {
  if (context.activity.type !== ActivityTypes.Message) return;

  // ── Branch A: Adaptive Card submit (confirmation response) ──
  const cardValue = context.activity.value as
    | { action?: string; neoSessionId?: string; toolId?: string }
    | undefined;

  if (cardValue?.action && cardValue.neoSessionId && cardValue.toolId) {
    const { action, neoSessionId, toolId } = cardValue;
    logger.info("Card submit received", "teams", { action, sessionId: neoSessionId });

    if (action !== "confirm" && action !== "cancel") {
      await context.sendActivity("Unknown action. Please use the card buttons.");
      return;
    }

    // Verify the submitter's identity — prevents cross-user confirmation
    const submitterAadId = context.activity.from?.aadObjectId;
    if (!submitterAadId) {
      logger.warn("Could not verify Teams submitter identity", "teams");
      await context.sendActivity("Could not verify your identity.");
      return;
    }

    const session = await sessionStore.get(neoSessionId);
    if (!session) {
      await context.sendActivity("Session expired. Please start a new conversation.");
      return;
    }

    // Only the session owner may confirm/cancel actions (mirrors confirm/route.ts)
    if (session.ownerId !== submitterAadId) {
      logger.warn("Teams confirm ownership mismatch", "teams", { sessionId: neoSessionId });
      await context.sendActivity("You are not authorized to confirm actions on this session.");
      return;
    }

    const pendingTool = await sessionStore.clearPendingConfirmation(neoSessionId);
    if (!pendingTool) {
      await context.sendActivity("No pending confirmation for this session.");
      return;
    }

    if (pendingTool.id !== toolId) {
      await sessionStore.setPendingConfirmation(neoSessionId, pendingTool);
      await context.sendActivity("Tool ID mismatch — confirmation rejected.");
      return;
    }

    if (!canUseTool(session.role, pendingTool.name)) {
      await sessionStore.setPendingConfirmation(neoSessionId, pendingTool);
      await context.sendActivity("Your role does not permit this action.");
      return;
    }

    const confirmed = action === "confirm";
    await context.sendActivities([{ type: ActivityTypes.Typing }]);

    const result = await resumeAfterConfirmation(
      session.messages,
      pendingTool,
      confirmed,
      {},
      session.role,
      neoSessionId
    );

    session.messages = result.messages;
    await sendAgentResult(context, result, neoSessionId);
    return;
  }

  // ── Branch B: Regular user message ──
  const messageText = context.activity.text?.trim();
  if (!messageText) return;

  const aadObjectId = context.activity.from?.aadObjectId;
  if (!aadObjectId) {
    logger.warn("Could not identify Teams user AAD account", "teams");
    await context.sendActivity(
      "Could not identify your Azure AD account. Please ensure you are signed in to Teams with your organizational account."
    );
    return;
  }

  const role = env.TEAMS_BOT_ROLE;
  const conversationId = context.activity.conversation.id;
  logger.info("Teams message received", "teams", { aadObjectIdHash: hashPii(aadObjectId), conversationId });

  // Resolve or create session
  let resolvedSessionId: string;
  const existingId = getSessionId(conversationId);
  const existingSession = existingId ? await sessionStore.get(existingId) : undefined;

  if (existingSession && existingId) {
    resolvedSessionId = existingId;
  } else {
    resolvedSessionId = await sessionStore.create(role, aadObjectId, "teams");
    setSessionId(conversationId, resolvedSessionId);
  }

  const session = (await sessionStore.get(resolvedSessionId))!;

  // Injection scan — mirrors the check in api/agent/route.ts
  const scanResult = scanUserInput(messageText, {
    sessionId: resolvedSessionId,
    userId: aadObjectId,
    role,
  });

  if (shouldBlock(scanResult)) {
    await context.sendActivity(
      "Your message could not be processed. Please rephrase your request."
    );
    return;
  }

  if (await sessionStore.isRateLimited(resolvedSessionId)) {
    logger.warn("Teams rate limit exceeded", "teams", { sessionId: resolvedSessionId });
    await context.sendActivity(
      "You have reached the message limit for this session. Please start a new conversation."
    );
    return;
  }

  session.messages.push({ role: "user", content: messageText });
  session.messageCount++;

  await context.sendActivities([{ type: ActivityTypes.Typing }]);

  const result = await runAgentLoop(session.messages, {}, session.role, resolvedSessionId);

  session.messages = result.messages;
  await sendAgentResult(context, result, resolvedSessionId);
}

// ─────────────────────────────────────────────────────────────
//  Next.js route handler — bridge Web Request/Response to
//  the Node.js IncomingMessage/ServerResponse that the
//  Bot Framework CloudAdapter expects.
// ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const bodyText = await request.text();
  const bodyParsed = JSON.parse(bodyText);

  // Build headers object
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Real Readable stream + parsed body so the SDK is happy either way
  const fakeReq = Object.assign(Readable.from(Buffer.from(bodyText, "utf-8")), {
    method: "POST",
    headers,
    body: bodyParsed,
  });

  // Capture the response written by the adapter
  let statusCode = 200;
  let responseBody = "";
  const responseHeaders: Record<string, string> = {};

  const fakeRes = {
    statusCode,
    status: (code: number) => {
      statusCode = code;
      fakeRes.statusCode = code;
      return fakeRes;
    },
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    header: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
    end: (body?: string) => {
      if (body) responseBody = body;
    },
    writeHead: (code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(responseHeaders, hdrs);
    },
    write: (chunk: string) => {
      responseBody += chunk;
    },
    send: (body?: string) => {
      if (body) responseBody = body;
    },
  };

  try {
    await getAdapter().process(fakeReq as never, fakeRes as never, handleTurn);
  } catch (err) {
    logger.error("Adapter process error", "teams", {
      errorMessage: (err as Error).message,
    });
    return new Response("Internal Server Error", { status: 500 });
  }

  return new Response(responseBody || null, {
    status: statusCode,
    headers: responseHeaders,
  });
}