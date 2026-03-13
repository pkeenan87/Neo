import crypto from "crypto";
import { RATE_LIMITS, type Role } from "./permissions";
import { logger, hashPii } from "./logger";
import type { Message, Session, SessionMeta, PendingTool, Channel } from "./types";

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

// ─────────────────────────────────────────────────────────────
//  SessionStore interface
// ─────────────────────────────────────────────────────────────

export interface SessionStore {
  create(role: Role, ownerId: string, channel?: Channel): Promise<string>;
  get(id: string): Promise<Session | undefined>;
  /** Return the session even if idle-expired (for resume scenarios).
   *  Note: InMemorySessionStore may return undefined if the periodic
   *  sweep has already removed the entry from the map. */
  getExpired(id: string): Promise<Session | undefined>;
  delete(id: string): Promise<boolean>;
  list(): Promise<SessionMeta[]>;
  listForOwner(ownerId: string): Promise<SessionMeta[]>;
  setPendingConfirmation(id: string, tool: PendingTool): Promise<void>;
  clearPendingConfirmation(id: string): Promise<PendingTool | null>;
  isRateLimited(id: string): Promise<boolean>;
  saveMessages(id: string, messages: Message[], title?: string): Promise<void>;
  updateTitle(id: string, title: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
//  In-memory implementation (used in MOCK_MODE or when Cosmos
//  is not configured)
// ─────────────────────────────────────────────────────────────

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  constructor() {
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  async create(role: Role, ownerId: string): Promise<string> {
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

  async get(id: string): Promise<Session | undefined> {
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

  async getExpired(id: string): Promise<Session | undefined> {
    // Returns raw map entry regardless of TTL. The periodic sweep may
    // have already removed it, in which case the caller treats this
    // as a fresh start (acceptable for mock/dev use).
    return this.sessions.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async list(): Promise<SessionMeta[]> {
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

  async listForOwner(ownerId: string): Promise<SessionMeta[]> {
    const all = await this.list();
    return all.filter((s) => s.ownerId === ownerId);
  }

  async setPendingConfirmation(id: string, tool: PendingTool): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.pendingConfirmation = tool;
      logger.info("Pending confirmation set", "session-store", { sessionId: id, toolName: tool.name, toolId: tool.id });
    }
  }

  async clearPendingConfirmation(id: string): Promise<PendingTool | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const pending = session.pendingConfirmation;
    session.pendingConfirmation = null;
    logger.info("Pending confirmation cleared", "session-store", { sessionId: id });
    return pending;
  }

  async isRateLimited(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    return session.messageCount >= RATE_LIMITS[session.role].messagesPerSession;
  }

  async saveMessages(_id: string, _messages: Message[], _title?: string): Promise<void> {
    // No-op — in-memory store is already mutated via direct object reference
  }

  async updateTitle(_id: string, _title: string): Promise<void> {
    // No-op — in-memory sessions don't persist titles
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
