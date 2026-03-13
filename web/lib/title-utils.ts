import { sessionStore } from "./session-factory";
import { generateTitle } from "./title-generator";
import { logger, hashPii } from "./logger";
import { messageToPlainText, sanitizeTitle } from "./extract-auto-title";
import type { Message } from "./types";

export { extractAutoTitle } from "./extract-auto-title";

/**
 * Fire-and-forget: generate a richer title via Haiku and overwrite the
 * fallback title in the store. Never throws — errors are logged and swallowed.
 */
export async function generateAndSetTitle(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  try {
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (!firstUser || !firstAssistant) return;

    const userText = messageToPlainText(firstUser.content);
    const assistantText = messageToPlainText(firstAssistant.content);
    if (!userText || !assistantText) return;

    const rawTitle = await generateTitle(userText, assistantText);
    const title = sanitizeTitle(rawTitle);
    if (title && title !== "New conversation") {
      await sessionStore.updateTitle(sessionId, title);
    }
  } catch (err) {
    logger.warn("Haiku title generation failed", "title-utils", {
      sessionId: hashPii(sessionId),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
