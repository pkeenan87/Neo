// Lightweight map from Teams conversationId to Neo sessionId.
// The sessionStore indexes by UUID session ID, not by Teams conversation ID,
// so this bridge is needed to find the right session for a conversation.

interface MapEntry {
  sessionId: string;
  createdAt: number;
}

const TTL_MS = 35 * 60 * 1000; // slightly longer than SessionStore's 30-min TTL
const map = new Map<string, MapEntry>();

// Periodic sweep matching the SessionStore pattern
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.createdAt > TTL_MS) {
      map.delete(key);
    }
  }
}, 60_000);

export function getSessionId(conversationId: string): string | undefined {
  return map.get(conversationId)?.sessionId;
}

export function setSessionId(conversationId: string, sessionId: string): void {
  map.set(conversationId, { sessionId, createdAt: Date.now() });
}

export function deleteSessionId(conversationId: string): void {
  map.delete(conversationId);
}
