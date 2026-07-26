import { ClientCommand, type ClientOptions } from "../client-command.js";
import { type CommandContext, type OptionSpec } from "../command.js";
import { resolveSessionId } from "../session-resolver.js";

export interface KillCommandOptions extends ClientOptions {
  signal?: string;
}

export class KillCommand extends ClientCommand<[string], KillCommandOptions> {
  readonly name = "kill <sessionId>";
  readonly description = "terminate a session";
  readonly extraOptions: OptionSpec[] = [{ flags: "--signal <signal>", description: "signal to send", default: "SIGTERM" }];

  async run(ctx: CommandContext<[string], KillCommandOptions>): Promise<void> {
    const [sessionIdOrPrefixOrName] = ctx.args;
    const options = ctx.options;
    const client = this.client(options);
    const sessionId = await resolveSessionId(client, undefined, sessionIdOrPrefixOrName);
    await client.killSession(sessionId, options.signal);
    console.log(`killed session ${sessionId}`);
  }
}
