// ─────────────────────────────────────────────────────────────
//  Teams channel poster
//
//  Posts a message to a Teams channel via Microsoft Graph using
//  the existing app-registration token (getMSGraphToken). The
//  app registration must have the `ChannelMessage.Send` (Application)
//  permission consented for this to work — see README permissions
//  table.
// ─────────────────────────────────────────────────────────────

import { getMSGraphToken } from "./auth";

export interface PostToChannelInput {
  teamId: string;
  channelId: string;
  text: string;
}

export class TeamsPostError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TeamsPostError";
  }
}

const TEAMS_CHANNEL_URL = (teamId: string, channelId: string) =>
  `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID_RE = /^[a-zA-Z0-9:_@\-=.]+$/;

function validate({ teamId, channelId }: PostToChannelInput): void {
  if (!GUID_RE.test(teamId)) {
    throw new TeamsPostError(`Invalid Teams team id format: ${teamId}`);
  }
  if (!CHANNEL_ID_RE.test(channelId)) {
    throw new TeamsPostError(`Invalid Teams channel id format`);
  }
}

export async function postToChannel(input: PostToChannelInput): Promise<void> {
  validate(input);

  const token = await getMSGraphToken();
  const res = await fetch(TEAMS_CHANNEL_URL(input.teamId, input.channelId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: { content: input.text, contentType: "text" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new TeamsPostError(
      `Teams channel post failed (${res.status}): ${errText}`,
      res.status,
    );
  }
}
