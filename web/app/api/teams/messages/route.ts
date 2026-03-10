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
import { runAgentLoop, resumeAfterConfirmation, summarizeConversation } from "@/lib/agent";
import { canUseTool } from "@/lib/permissions";
import { scanUserInput, shouldBlock } from "@/lib/injection-guard";
import { logger, hashPii } from "@/lib/logger";
import {
  getSessionId,
  setSessionId,
  updateSessionId,
  refreshMapping,
} from "@/lib/teams-session-map";
import type { PendingTool, AgentLoopResult, TeamsChannelType } from "@/lib/types";

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

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Reformat markdown for Teams' limited renderer.
 *
 * Teams requires a blank line before the first list item and does not
 * handle nested indentation deeper than one level. This function:
 *  1. Ensures a blank line precedes every list block (bulleted or numbered)
 *  2. Flattens nested lists beyond 1 indent level (Teams ignores deeper nesting)
 *  3. Normalises bullet markers to `- ` (Teams handles this most consistently)
 */
function formatForTeams(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isListItem = /^\s*[-*+]\s/.test(line) || /^\s*\d+[.)]\s/.test(line);

    if (isListItem) {
      // Ensure a blank line before the first item of a list block
      const prev = result[result.length - 1];
      const prevIsListItem =
        prev !== undefined &&
        (/^\s*[-*+]\s/.test(prev) || /^\s*\d+[.)]\s/.test(prev));
      const prevIsBlank = prev === undefined || prev.trim() === "";

      if (!prevIsBlank && !prevIsListItem) {
        result.push("");
      }

      // Flatten deep nesting: keep at most 1 indent level (3 spaces)
      const stripped = line.replace(/^(\s*)/, (_, ws: string) => {
        const spaces = ws.replace(/\t/g, "    ").length;
        if (spaces <= 2) return "";
        return "   "; // single indent
      });

      // Normalise bullet marker to dash
      const normalised = stripped.replace(/^(\s*)[*+]\s/, "$1- ");
      result.push(normalised);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Split text on paragraph boundaries (\n\n) so chunks don't break
 * mid-markdown-element. Falls back to character-level splitting for
 * single paragraphs that exceed the limit.
 */
function chunkByParagraph(text: string, maxLen: number): string[] {
  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // Single paragraph exceeds limit — fall back to character splitting
      if (para.length > maxLen) {
        for (let i = 0; i < para.length; i += maxLen) {
          chunks.push(para.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = para;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

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
    const MAX_LEN = 20_000;
    const text = formatForTeams(normalizeText(result.text));
    const chunks = chunkByParagraph(text, MAX_LEN);

    for (const chunk of chunks) {
      await context.sendActivity({
        type: "message",
        text: chunk,
        textFormat: "markdown",
      });
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

    // Validate conversation-origin binding: the card-submit must come from
    // a conversation that owns this session (prevents cross-conversation replay).
    const cardConversationId = context.activity.conversation.id;
    const mappedSessionId = await getSessionId(cardConversationId);
    if (mappedSessionId !== neoSessionId) {
      logger.warn("Card submit conversation-origin mismatch", "teams", {
        sessionId: neoSessionId,
        conversationId: cardConversationId,
      });
      await context.sendActivity("This confirmation does not belong to this conversation.");
      return;
    }

    const session = await sessionStore.get(neoSessionId);
    if (!session) {
      await context.sendActivity("Session expired. Please start a new conversation.");
      return;
    }

    // For channel threads (synthetic owner), RBAC is enforced at the Teams
    // channel level — any channel member with the configured role can confirm.
    // For DMs, verify the submitter owns the session.
    if (!session.ownerId.startsWith("teams-thread:") && session.ownerId !== submitterAadId) {
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

    // Check role against the actual tool name (not the UUID toolId)
    if (!canUseTool(env.TEAMS_BOT_ROLE, pendingTool.name)) {
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
  const conversationType = context.activity.conversation.conversationType ?? "";

  // Derive thread detection from conversationId structure (`;messageid=` is
  // present in channel thread IDs) rather than relying solely on the
  // conversationType field from the activity payload.
  const isThread =
    conversationType === "channel" || conversationId.includes(";messageid=");
  const channelType: TeamsChannelType = isThread ? "thread" : "dm";
  const teamId = (context.activity.channelData as { team?: { id?: string } })?.team?.id ?? null;

  if (!["channel", "personal", "groupChat"].includes(conversationType)) {
    logger.warn("Unexpected Teams conversation type", "teams", { conversationType });
  }

  logger.info("Teams message received", "teams", {
    aadObjectIdHash: hashPii(aadObjectId),
    conversationId,
    channelType,
  });

  // ── Resolve or create session ──────────────────────────────
  // Owner: for DMs use the user's AAD ID; for threads use a synthetic ID
  const ownerId = isThread
    ? `teams-thread:${conversationId}`
    : aadObjectId;

  let resolvedSessionId: string;
  const existingId = await getSessionId(conversationId);

  if (existingId) {
    // Check if the session is still active
    const activeSession = await sessionStore.get(existingId);
    if (activeSession) {
      resolvedSessionId = existingId;
      refreshMapping(conversationId).catch((err) => {
        logger.warn("refreshMapping failed", "teams", {
          conversationId,
          errorMessage: (err as Error).message,
        });
      });
    } else {
      // Session idle-expired — try to resume with summary
      const expiredSession = await sessionStore.getExpired(existingId);
      if (expiredSession && expiredSession.messages.length > 0) {
        logger.info("Resuming expired Teams session with summary", "teams", {
          expiredSessionId: existingId,
        });
        const summaryMessages = await summarizeConversation(expiredSession.messages);
        resolvedSessionId = await sessionStore.create(role, ownerId, "teams");
        const newSession = await sessionStore.get(resolvedSessionId);
        if (!newSession) {
          logger.error("Session missing immediately after create", "teams", { resolvedSessionId });
          await context.sendActivity("An internal error occurred. Please try again.");
          return;
        }
        newSession.messages.push(...summaryMessages);
        await sessionStore.saveMessages(resolvedSessionId, newSession.messages);
        await updateSessionId(conversationId, resolvedSessionId);
      } else {
        // Document TTL-deleted or empty — start fresh
        resolvedSessionId = await sessionStore.create(role, ownerId, "teams");
        await updateSessionId(conversationId, resolvedSessionId);
      }
    }
  } else {
    // No mapping exists — create new session and mapping
    resolvedSessionId = await sessionStore.create(role, ownerId, "teams");
    await setSessionId(conversationId, resolvedSessionId, channelType, teamId);
  }

  const session = await sessionStore.get(resolvedSessionId);
  if (!session) {
    logger.error("Session missing after resolution", "teams", { resolvedSessionId });
    await context.sendActivity("An internal error occurred. Please try again.");
    return;
  }

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

  // Persist user message immediately (before agent loop)
  try {
    await sessionStore.saveMessages(resolvedSessionId, session.messages);
  } catch (err) {
    logger.warn("Failed to persist Teams message on receipt", "teams", {
      sessionId: resolvedSessionId,
      errorMessage: (err as Error).message,
    });
  }

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