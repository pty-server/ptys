import { randomBytes, randomUUID } from "node:crypto";
import { PtySession, type PtySessionOptions, type Session } from "./session.js";

export type CreateSessionOptions = Omit<PtySessionOptions, "id">;

export const DEFAULT_MAX_CLOSED_SESSIONS = 100;

export const FIRST_ATTACH_GRACE_MS = 30_000;

export interface SessionManagerOptions {
  scrollback?: number;
  eventEndpoint?: string;
  maxClosedSessions?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly scrollback?: number;
  private readonly eventEndpoint?: string;
  private readonly maxClosedSessions: number;
  private readonly createCallbacks = new Set<(session: Session) => void>();
  private graceTimer?: NodeJS.Timeout;

  constructor(options: SessionManagerOptions = {}) {
    this.scrollback = options.scrollback;
    this.eventEndpoint = options.eventEndpoint;
    this.maxClosedSessions = options.maxClosedSessions ?? DEFAULT_MAX_CLOSED_SESSIONS;
  }

  create(options: CreateSessionOptions): Session {
    const session = new PtySession({
      scrollback: this.scrollback,
      eventEndpoint: this.eventEndpoint,
      eventToken: randomBytes(32).toString("base64url"),
      ...options,
      id: randomUUID(),
    });
    this.sessions.set(session.id, session);
    session.onExit(() => this.reapClosedSessions());
    for (const callback of this.createCallbacks) callback(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getByEventToken(token: string | undefined): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.verifyEventToken(token)) return session;
    }
    return undefined;
  }

  onCreate(callback: (session: Session) => void): () => void {
    this.createCallbacks.add(callback);
    return () => this.createCallbacks.delete(callback);
  }

  list(options?: { workspaceId?: string }): Session[] {
    const sessions = [...this.sessions.values()];
    return options?.workspaceId === undefined
      ? sessions
      : sessions.filter((session) => session.workspaceId === options.workspaceId);
  }

  delete(id: string, signal = "SIGTERM"): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return false;
    }
    if (session.toJSON().exited !== undefined) {
      this.sessions.delete(id);
      return true;
    }
    session.kill(signal);
    return true;
  }

  signal(id: string, signal: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return false;
    }
    session.kill(signal);
    return true;
  }

  rename(id: string, name: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return undefined;
    }
    session.rename(name);
    return session;
  }

  markAttached(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined || session.everAttached) {
      return;
    }
    session.markAttached();
    this.reapClosedSessions();
  }

  shutdown(): void {
    this.scheduleGraceSweep(undefined);
    for (const session of this.sessions.values()) {
      session.kill("SIGTERM");
    }
  }

  private reapClosedSessions(): void {
    const now = Date.now();
    const closed = [...this.sessions.values()]
      .flatMap((session) => {
        const exited = session.toJSON().exited;
        return exited === undefined ? [] : [{ session, exitedAt: exited.at }];
      })
      .sort((left, right) => left.exitedAt - right.exitedAt);

    const protectedUntil = (entry: { session: Session; exitedAt: number }): number =>
      entry.session.everAttached ? 0 : entry.exitedAt + FIRST_ATTACH_GRACE_MS;
    const reapable = closed.filter((entry) => protectedUntil(entry) <= now);
    const excess = reapable.length - this.maxClosedSessions;
    for (const { session } of reapable.slice(0, Math.max(0, excess))) {
      this.sessions.delete(session.id);
    }

    const nextExpiry = closed
      .map(protectedUntil)
      .filter((expiry) => expiry > now)
      .sort((left, right) => left - right)[0];
    this.scheduleGraceSweep(nextExpiry === undefined ? undefined : nextExpiry - now);
  }

  private scheduleGraceSweep(delay: number | undefined): void {
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    if (delay === undefined) {
      return;
    }
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      this.reapClosedSessions();
    }, delay);
    this.graceTimer.unref();
  }
}
