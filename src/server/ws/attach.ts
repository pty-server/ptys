import { type RawData, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  ResizeControlSchema,
  SignalControlSchema,
  type ServerControlMessage,
} from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import { AttachRegistry, type ClientEntry } from "./attach-registry.js";
import { decideCoalescingTick, decideForward } from "./backpressure.js";
import type { Session } from "../session.js";
import type { SessionManager } from "../session-manager.js";
import { createWebSocketUpgrade, UpgradeRejection, type UpgradeHandler, type WebSocketUpgradeOptions } from "./upgrade.js";

const ATTACH_PATH = /^\/v1\/sessions\/([^/]+)\/attach$/;

const BACKPRESSURE_CHECK_INTERVAL_MS = 100; // ~10Hz
const PING_INTERVAL_MS = 15_000;

export interface AttachUpgradeOptions extends WebSocketUpgradeOptions {
  registry?: AttachRegistry;
}

export function createAttachUpgradeHandler(
  sessionManager: SessionManager,
  options: AttachUpgradeOptions = {},
): UpgradeHandler {
  const registry = options.registry ?? new AttachRegistry();
  return createWebSocketUpgrade(
    options,
    (url) => {
      const match = ATTACH_PATH.exec(url.pathname);
      if (match === null) {
        throw new UpgradeRejection(404, "not found");
      }
      const sessionId = decodeURIComponent(match[1]);
      const session = sessionManager.get(sessionId);
      if (session === undefined) {
        throw new UpgradeRejection(404, "session not found");
      }
      sessionManager.markAttached(sessionId);
      return session;
    },
    (ws, session, url) => attachClient(ws, session, url.searchParams, registry),
  );
}

function attachClient(ws: WebSocket, session: Session, params: URLSearchParams, registry: AttachRegistry): void {
  const readonly = isTruthyFlag(params.get("readonly"));
  const lossy = isTruthyFlag(params.get("lossy"));
  const cols = parsePositiveInt(params.get("cols"));
  const rows = parsePositiveInt(params.get("rows"));

  const entry: ClientEntry = { ws, readonly, lossy, cols, rows, bpState: "live" };
  registry.add(session.id, entry);

  // Order is the behavior: subscribe before anything can be emitted, settle the size so the
  // snapshot and the ready frame agree on it, only then open the barrier.
  const barrier = subscribeSnapshotBarrier(entry, session);
  applyInitialSize(registry, session, entry);
  barrier.open();

  const stopKeepalive = startKeepalive(entry);
  const stopBackpressureLoop = startBackpressureLoop(entry, session);

  ws.on("close", () => {
    barrier.close();
    stopKeepalive();
    stopBackpressureLoop();
    registry.remove(session.id, entry);
    if (!readonly && session.followSize) {
      applyFollowSize(registry, session);
    }
  });

  pumpClientMessages(entry, session, registry);
}

interface SnapshotBarrier {
  open(): void;
  close(): void;
}

// Until `open` resolves the snapshot, live output is buffered rather than forwarded. Replaying only
// chunks newer than the marker sequence is what keeps the client from seeing dupes or gaps.
function subscribeSnapshotBarrier(entry: ClientEntry, session: Session): SnapshotBarrier {
  const ws = entry.ws;
  let live = false;
  const buffered: Array<{ seq: number; chunk: string }> = [];
  let pendingExit: { code: number; signal?: number } | undefined;

  const offData = session.onData((chunk, seq) => {
    if (live) {
      forwardChunk(entry, session, chunk);
      return;
    }
    buffered.push({ seq, chunk });
  });

  const offExit = session.onExit((event) => {
    if (!live) {
      pendingExit = { code: event.code, signal: event.signal };
      return;
    }
    sendControl(ws, { t: "exit", code: event.code, signal: event.signal });
    ws.close();
  });

  return {
    open(): void {
      const markerSeq = session.currentSeq;
      void session.snapshot().then((snapshot) => {
        const dims = session.toJSON();
        sendControl(ws, {
          t: "ready",
          protocol: PROTOCOL_VERSION,
          sessionId: session.id,
          cols: dims.cols,
          rows: dims.rows,
        });

        if (snapshot.length > 0 && ws.readyState === ws.OPEN) {
          ws.send(Buffer.from(snapshot, "utf8"));
        }

        for (const { seq, chunk } of buffered) {
          if (seq <= markerSeq) {
            continue; // already reflected in the snapshot
          }
          forwardChunk(entry, session, chunk);
        }
        buffered.length = 0;
        live = true;

        const exited = pendingExit ?? session.toJSON().exited;
        if (exited !== undefined && ws.readyState === ws.OPEN) {
          sendControl(ws, { t: "exit", code: exited.code, signal: exited.signal });
          ws.close();
        }
      });
    },
    close(): void {
      offData();
      offExit();
    },
  };
}

function applyInitialSize(registry: AttachRegistry, session: Session, entry: ClientEntry): void {
  if (entry.readonly || entry.cols === undefined || entry.rows === undefined) {
    return;
  }
  if (session.followSize) {
    applyFollowSize(registry, session, entry);
    return;
  }
  // A late joiner must not resize the terminal out from under an existing read-write client.
  const dims = session.toJSON();
  if (registry.countOtherReadWrite(session.id, entry) !== 0) {
    return;
  }
  if (entry.cols !== dims.cols || entry.rows !== dims.rows) {
    session.resize(entry.cols, entry.rows);
    broadcastResized(registry, session, entry);
  }
}

function startKeepalive(entry: ClientEntry): () => void {
  const ws = entry.ws;
  let alive = true;
  const onPong = (): void => {
    alive = true;
  };
  ws.on("pong", onPong);
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN || entry.bpState === "dead") {
      return;
    }
    if (!alive) {
      killSlow(entry, "connection unresponsive");
      return;
    }
    alive = false;
    ws.ping();
  }, PING_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    ws.off("pong", onPong);
  };
}

function startBackpressureLoop(entry: ClientEntry, session: Session): () => void {
  const ws = entry.ws;
  const timer = setInterval(() => {
    if (entry.bpState !== "coalescing" || ws.readyState !== ws.OPEN) {
      return;
    }
    switch (decideCoalescingTick(ws.bufferedAmount)) {
      case "kill":
        killSlow(entry);
        return;
      case "exit-to-live":
        entry.bpState = "live";
        return;
      case "snapshot":
        pushCoalescedSnapshot(entry, session);
        return;
    }
  }, BACKPRESSURE_CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

function pumpClientMessages(entry: ClientEntry, session: Session, registry: AttachRegistry): void {
  const ws = entry.ws;
  ws.on("message", (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        if (!entry.readonly) {
          session.write(toBuffer(data));
        }
        return;
      }
      handleControlMessage(ws, entry, session, registry, data.toString(), entry.readonly);
    } catch {
      sendControl(ws, { t: "error", reason: "session operation failed" });
      ws.close();
    }
  });
}

function forwardChunk(entry: ClientEntry, session: Session, chunk: string): void {
  const ws = entry.ws;
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  const eligible = entry.readonly || entry.lossy;
  const previousState = entry.bpState;
  const decision = decideForward(previousState, ws.bufferedAmount, eligible);
  entry.bpState = decision.nextState;

  switch (decision.action) {
    case "kill":
      killSlow(entry);
      return;
    case "drop":
      if (previousState === "live" && decision.nextState === "coalescing") {
        pushCoalescedSnapshot(entry, session);
      }
      return;
    case "send":
      ws.send(Buffer.from(chunk, "utf8"));
      return;
  }
}

function pushCoalescedSnapshot(entry: ClientEntry, session: Session): void {
  void session.snapshot().then((snapshot) => {
    if (entry.bpState !== "coalescing" || entry.ws.readyState !== entry.ws.OPEN) {
      return;
    }
    if (snapshot.length > 0) {
      entry.ws.send(Buffer.from(snapshot, "utf8"));
    }
  });
}

function killSlow(entry: ClientEntry, reason = "client too slow"): void {
  if (entry.bpState === "dead") {
    return;
  }
  entry.bpState = "dead";
  sendControl(entry.ws, { t: "error", reason });
  entry.ws.close();
}

function handleControlMessage(
  ws: WebSocket,
  entry: ClientEntry,
  session: Session,
  registry: AttachRegistry,
  raw: string,
  readonly: boolean,
): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    sendControl(ws, { t: "error", reason: "invalid JSON" });
    return;
  }

  if (!isControlEnvelope(message)) {
    sendControl(ws, { t: "error", reason: "invalid control message" });
    return;
  }

  if (readonly) {
    return;
  }

  if (message.t === "resize") {
    if (!Value.Check(ResizeControlSchema, message)) {
      sendControl(ws, { t: "error", reason: "resize requires cols and rows" });
      return;
    }
    entry.cols = message.cols;
    entry.rows = message.rows;
    if (session.followSize) {
      applyFollowSize(registry, session);
    } else {
      session.resize(message.cols, message.rows);
      broadcastResized(registry, session);
    }
    return;
  }

  if (message.t === "signal") {
    if (!Value.Check(SignalControlSchema, message)) {
      sendControl(ws, { t: "error", reason: "signal requires sig" });
      return;
    }
    session.kill(message.sig);
    return;
  }

}

function broadcastResized(registry: AttachRegistry, session: Session, exclude?: ClientEntry): void {
  const dims = session.toJSON();
  for (const client of registry.peers(session.id)) {
    if (client !== exclude) {
      sendControl(client.ws, { t: "resized", cols: dims.cols, rows: dims.rows });
    }
  }
}

function applyFollowSize(registry: AttachRegistry, session: Session, exclude?: ClientEntry): void {
  const size = registry.minSize(session.id);
  if (size === undefined) {
    return;
  }
  const dims = session.toJSON();
  if (size.cols !== dims.cols || size.rows !== dims.rows) {
    session.resize(size.cols, size.rows);
    broadcastResized(registry, session, exclude);
  }
}

function sendControl(ws: WebSocket, message: ServerControlMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function isTruthyFlag(value: string | null): boolean {
  return value === "1" || value === "true";
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isControlEnvelope(value: unknown): value is { t: unknown } {
  return value !== null && typeof value === "object" && "t" in value;
}
