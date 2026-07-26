import type { WebSocket } from "ws";
import type { BackpressureState } from "./backpressure.js";

export interface ClientEntry {
  ws: WebSocket;
  readonly: boolean;
  lossy: boolean;
  cols?: number;
  rows?: number;
  bpState: BackpressureState;
}

// One registry is shared by every listener, so a resize on the control socket reaches clients
// attached over TCP. Each listener builds its own upgrade handler; the registry is what joins them.
export class AttachRegistry {
  private readonly bySession = new Map<string, Set<ClientEntry>>();

  add(sessionId: string, entry: ClientEntry): void {
    let clients = this.bySession.get(sessionId);
    if (clients === undefined) {
      clients = new Set();
      this.bySession.set(sessionId, clients);
    }
    clients.add(entry);
  }

  remove(sessionId: string, entry: ClientEntry): void {
    const clients = this.bySession.get(sessionId);
    if (clients === undefined) {
      return;
    }
    clients.delete(entry);
    if (clients.size === 0) {
      this.bySession.delete(sessionId);
    }
  }

  peers(sessionId: string): Iterable<ClientEntry> {
    return this.bySession.get(sessionId) ?? [];
  }

  countOtherReadWrite(sessionId: string, self: ClientEntry): number {
    let count = 0;
    for (const client of this.peers(sessionId)) {
      if (client !== self && !client.readonly) {
        count++;
      }
    }
    return count;
  }

  minSize(sessionId: string): { cols: number; rows: number } | undefined {
    let cols: number | undefined;
    let rows: number | undefined;
    for (const client of this.peers(sessionId)) {
      if (client.readonly || client.cols === undefined || client.rows === undefined) {
        continue;
      }
      cols = cols === undefined ? client.cols : Math.min(cols, client.cols);
      rows = rows === undefined ? client.rows : Math.min(rows, client.rows);
    }
    return cols === undefined || rows === undefined ? undefined : { cols, rows };
  }
}
