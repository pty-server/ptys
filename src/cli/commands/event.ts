import { Value } from "@sinclair/typebox/value";
import { EventInputSchema, type EventInput } from "@pty-server/protocol";
import { BaseCommand, type CommandContext, type OptionSpec } from "../command.js";
import { parseEndpoint, sendRequest, type HttpResponse } from "../http.js";

export interface EventCommandOptions {
  request?: boolean;
  timeout?: string;
}

function parseTimeout(value: string | undefined, request: boolean): number | undefined {
  if (value === undefined) return request ? 30 : undefined;
  if (!request) throw new Error("--timeout requires --request");
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) {
    throw new Error("--timeout must be a number of seconds from 0 to 300");
  }
  return seconds;
}

export class EventCommand extends BaseCommand<[string], EventCommandOptions> {
  readonly name = "event <json>";
  readonly description = "emit an event from inside a ptys session";
  get options(): OptionSpec[] {
    return [
      { flags: "--request", description: "wait for the first event reply" },
      { flags: "--timeout <seconds>", description: "request timeout in seconds; 0 waits indefinitely" },
    ];
  }

  async run(ctx: CommandContext<[string], EventCommandOptions>): Promise<void> {
    const [raw] = ctx.args;
    const options = ctx.options;
    const endpoint = process.env.PTYS_EVENT_ENDPOINT;
    if (endpoint === undefined || endpoint.length === 0) {
      throw new Error("ptys event must run inside a ptys session");
    }

    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error("event must be valid JSON");
    }
    if (!Value.Check(EventInputSchema, input)) {
      throw new Error("event must be an object with non-empty type and data properties");
    }
    if ("sessionId" in input) {
      throw new Error("sessionId is assigned by the server");
    }
    const event = input as EventInput;

    const request = options.request ?? false;
    const timeoutSeconds = parseTimeout(options.timeout, request);
    const { path, ...target } = parseEndpoint(endpoint);
    let response: HttpResponse;
    try {
      response = await sendRequest(target, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...event, request, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) }),
      });
    } catch {
      throw new Error("event request failed");
    }
    let body: { error?: unknown; event?: { data?: unknown } } | undefined;
    try {
      body = JSON.parse(response.body) as { error?: unknown; event?: { data?: unknown } };
    } catch {
      body = undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = typeof body?.error === "string" ? body.error : "event request failed";
      throw new Error(detail);
    }
    if (request) console.log(JSON.stringify(body?.event?.data));
  }
}
