import crypto from "crypto";
import { RATE_LIMITS, type Role } from "./permissions";
import { logger, hashPii } from "./logger";
import type { Session, SessionMeta, PendingTool } from "./types";

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

class SessionStore {
  private sessions = new Map<string, Session>();

  constructor() {
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  create(role: Role, ownerId: string): string {
    const id = crypto.randomUUID();
    this.sessions.set(id, {
      id,
      role,
      ownerId,
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: 0,
      pendingConfirmation: null,
    });
    logger.info("Session created", "session-store", { sessionId: id, role, ownerIdHash: hashPii(ownerId) });
    return id;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    if (Date.now() - session.lastActivityAt.getTime() > TTL_MS) {
      logger.info("Session expired", "session-store", { sessionId: id });
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
          role: session.role,
          ownerId: session.ownerId,
          createdAt: session.createdAt,
          messageCount: session.messageCount,
        });
      }
    }
    return result;
  }

  listForOwner(ownerId: string): SessionMeta[] {
    return this.list().filter((s) => s.ownerId === ownerId);
  }

  setPendingConfirmation(id: string, tool: PendingTool): void {
    const session = this.sessions.get(id);
    if (session) {
      session.pendingConfirmation = tool;
      logger.info("Pending confirmation set", "session-store", { sessionId: id, toolName: tool.name, toolId: tool.id });
    }
  }

  clearPendingConfirmation(id: string): PendingTool | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const pending = session.pendingConfirmation;
    session.pendingConfirmation = null;
    logger.info("Pending confirmation cleared", "session-store", { sessionId: id });
    return pending;
  }

  isRateLimited(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    return session.messageCount >= RATE_LIMITS[session.role].messagesPerSession;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > TTL_MS) {
        logger.debug("Session swept", "session-store", { sessionId: id });
        this.sessions.delete(id);
      }
    }
  }
}

export const sessionStore = new SessionStore();
