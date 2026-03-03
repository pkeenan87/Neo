import crypto from "crypto";
import type { Session, SessionMeta, PendingTool } from "./types";

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute
const MESSAGE_LIMIT = 100;

class SessionStore {
  private sessions = new Map<string, Session>();

  constructor() {
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  create(): string {
    const id = crypto.randomUUID();
    this.sessions.set(id, {
      id,
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: 0,
      pendingConfirmation: null,
    });
    return id;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    if (Date.now() - session.lastActivityAt.getTime() > TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }

    session.lastActivityAt = new Date();
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): SessionMeta[] {
    const now = Date.now();
    const result: SessionMeta[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt.getTime() <= TTL_MS) {
        result.push({
          id: session.id,
          createdAt: session.createdAt,
          messageCount: session.messageCount,
        });
      }
    }
    return result;
  }

  setPendingConfirmation(id: string, tool: PendingTool): void {
    const session = this.sessions.get(id);
    if (session) {
      session.pendingConfirmation = tool;
    }
  }

  clearPendingConfirmation(id: string): PendingTool | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const pending = session.pendingConfirmation;
    session.pendingConfirmation = null;
    return pending;
  }

  isRateLimited(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    return session.messageCount >= MESSAGE_LIMIT;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }
}

export const sessionStore = new SessionStore();
