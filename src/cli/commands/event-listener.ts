import { WebSocket } from "ws";
import type { EventStreamServerMessage } from "@pty-server/protocol";
import { ClientCommand, type ClientOptions } from "../client-command.js";
import { type CommandContext, type OptionSpec } from "../command.js";
import { resolveTarget } from "../target.js";
import { webSocketHeaders, webSocketUrl } from "../websocket-url.js";

export type EventListenerOptions = ClientOptions;

export class EventListenerCommand extends ClientCommand<[], EventListenerOptions> {
  readonly name = "event-listener";
  readonly description = "stream server events to stdout";
  readonly extraOptions: OptionSpec[] = [];

  async run(ctx: CommandContext<[], EventListenerOptions>): Promise<void> {
    const options = ctx.options;
    const target = resolveTarget(options);
    const ws = new WebSocket(webSocketUrl(target, "/v1/events"), webSocketHeaders(target));

    await new Promise<void>((_resolve, reject) => {
      let opened = false;
      ws.on("open", () => { opened = true; });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let message: EventStreamServerMessage;
        try {
          message = JSON.parse(data.toString()) as EventStreamServerMessage;
        } catch {
          return;
        }
        if (message.t === "event") {
          process.stdout.write(`${JSON.stringify(message.event)}\n`);
        } else if (message.t === "error") {
          process.stderr.write(`ptys: ${message.reason}\n`);
        }
      });
      ws.on("close", (code, reason) => {
        const detail = reason.length > 0 ? `: ${reason.toString()}` : "";
        reject(new Error(opened
          ? `event stream closed by the server (code ${code})${detail}`
          : `event stream closed before it opened (code ${code})${detail}`));
      });
      ws.on("error", (error) => reject(error));
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(response.statusCode === 401 ? "unauthorized - set PTYS_TOKEN or --token" : `unexpected response ${response.statusCode}`));
      });
    });
  }
}
