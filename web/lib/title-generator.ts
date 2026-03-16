import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config";
import { logger } from "./logger";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Generate a short conversation title from the first exchange.
 * Called asynchronously (fire-and-forget) after the first assistant response.
 */
export async function generateTitle(
  firstUserMessage: string,
  firstAssistantResponse: string,
): Promise<string> {
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-latest",
      max_tokens: 30,
      messages: [
        {
          role: "user",
          content: `Generate a short title (max 8 words) for a SOC analyst conversation that started with the question and response below. Return ONLY the title, no quotes.

<user_message>${firstUserMessage}</user_message>
<assistant_response>${firstAssistantResponse.slice(0, 500)}</assistant_response>`,
        },
      ],
    });

    const block = resp.content[0];
    if (block.type === "text" && block.text.trim()) {
      return block.text.trim();
    }
    return "New conversation";
  } catch (err) {
    logger.warn("Title generation failed, using fallback", "title-generator", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return "New conversation";
  }
}
