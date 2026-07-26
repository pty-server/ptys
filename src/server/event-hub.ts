import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { EventEnvelope, EventInput, EventReplyControl } from "@pty-server/protocol";

export const EVENTS_PATH = "/v1/events";

export class NoEventSubscriberError extends Error {}
export class EventRequestTimeoutError extends Error {}
export class EventSessionEndedError extends Error {}

interface PendingRequest {
  readonly sessionId: string;
  readonly resolve: (event: EventInput) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class EventHub {
  private readonly clients = new Set<WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.once("close", () => this.clients.delete(ws));
  }

  publish(event: EventEnvelope): number {
    const message = JSON.stringify({ t: "event", event });
    let delivered = 0;
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN) continue;
      client.send(message);
      delivered++;
    }
    return delivered;
  }

  request(event: EventEnvelope, timeoutSeconds: number): Promise<EventInput> {
    const clients = [...this.clients].filter((client) => client.readyState === client.OPEN);
    if (clients.length === 0) throw new NoEventSubscriberError("no event subscriber connected");

    const requestId = randomUUID();
    const message = JSON.stringify({ t: "event", event, requestId, ttl: timeoutSeconds });
    return new Promise<EventInput>((resolve, reject) => {
      const pending: PendingRequest = { sessionId: event.sessionId, resolve, reject };
      if (timeoutSeconds > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new EventRequestTimeoutError("event request timed out"));
        }, timeoutSeconds * 1000);
      }
      this.pending.set(requestId, pending);
      for (const client of clients) client.send(message);
    });
  }

  reply(reply: EventReplyControl): "accepted" | "unknown" {
    const pending = this.pending.get(reply.requestId);
    if (pending === undefined) return "unknown";
    this.pending.delete(reply.requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.resolve(reply.event);
    return "accepted";
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new EventSessionEndedError("session ended before event request was answered"));
    }
  }

  close(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new EventSessionEndedError("server stopped before event request was answered"));
    }
    this.pending.clear();
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}
