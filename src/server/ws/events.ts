import { type RawData, type WebSocket } from "ws";
import { EventReplyControlSchema } from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import { EVENTS_PATH, type EventHub } from "../event-hub.js";
import { createWebSocketUpgrade, UpgradeRejection, type UpgradeHandler, type WebSocketUpgradeOptions } from "./upgrade.js";

export type EventsUpgradeOptions = WebSocketUpgradeOptions;

export function createEventsUpgradeHandler(hub: EventHub, options: EventsUpgradeOptions = {}): UpgradeHandler {
  return createWebSocketUpgrade(
    options,
    (url) => {
      if (url.pathname !== EVENTS_PATH) {
        throw new UpgradeRejection(404, "not found");
      }
      return hub;
    },
    (ws) => {
      hub.addClient(ws);
      ws.on("error", () => {});
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          sendError(ws, "event replies must be JSON");
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch {
          sendError(ws, "invalid JSON");
          return;
        }
        if (!Value.Check(EventReplyControlSchema, message)) {
          sendError(ws, "invalid event reply");
          return;
        }
        if (hub.reply(message) === "unknown") sendError(ws, "unknown or expired event request");
      });
    },
  );
}

function sendError(ws: WebSocket, reason: string): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "error", reason }));
}
