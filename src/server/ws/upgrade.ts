import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { SUBPROTOCOL_PREFIX, extractBearerToken, extractSubprotocolToken, verifyToken } from "../auth.js";
import { OriginAllowlist } from "../origin-allowlist.js";

export interface WebSocketUpgradeOptions {
  token?: string;
  origins?: OriginAllowlist;
}

export type UpgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => void;

export class UpgradeRejection extends Error {
  readonly statusCode: number;
  readonly reason: string;

  constructor(statusCode: number, reason: string) {
    super(reason);
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

// Token, then origin, then route: an unauthenticated caller must not learn which paths exist.
export function createWebSocketUpgrade<T>(
  options: WebSocketUpgradeOptions,
  route: (url: URL) => T,
  onConnection: (ws: WebSocket, target: T, url: URL) => void,
): UpgradeHandler {
  const origins = options.origins ?? new OriginAllowlist();
  const wss = new WebSocketServer({ noServer: true, handleProtocols: pickBearerSubprotocol });

  return function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (options.token !== undefined) {
      const presented = extractBearerToken(request.headers.authorization)
        ?? extractSubprotocolToken(request.headers["sec-websocket-protocol"]);
      if (!verifyToken(presented, options.token)) {
        rejectUpgrade(socket, 401, "unauthorized");
        return;
      }
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      rejectUpgrade(socket, 403, "origin not allowed");
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let target: T;
    try {
      target = route(url);
    } catch (error) {
      if (!(error instanceof UpgradeRejection)) throw error;
      rejectUpgrade(socket, error.statusCode, error.reason);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, target, url));
  };
}

function pickBearerSubprotocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) {
    if (protocol.startsWith(SUBPROTOCOL_PREFIX) && protocol.length > SUBPROTOCOL_PREFIX.length) {
      return protocol;
    }
  }
  return false;
}

function rejectUpgrade(socket: Socket, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
