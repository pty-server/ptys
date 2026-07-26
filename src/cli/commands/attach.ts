import { runAttachClient } from "../attach-client.js";
import { ClientCommand, type ClientOptions } from "../client-command.js";
import { LOSSY_OPTION, type CommandContext, type OptionSpec } from "../command.js";

export interface AttachCommandOptions extends ClientOptions {
  readOnly?: boolean;
  lossy?: boolean;
}

export class AttachCommand extends ClientCommand<[string], AttachCommandOptions> {
  readonly name = "attach <sessionId>";
  readonly description = "attach to a running session";
  readonly extraOptions: OptionSpec[] = [{ flags: "--read-only", description: "attach without writing to the session" }, LOSSY_OPTION];

  async run(ctx: CommandContext<[string], AttachCommandOptions>): Promise<void> {
    const [sessionIdOrPrefixOrName] = ctx.args;
    await runAttachClient(sessionIdOrPrefixOrName, ctx.options);
  }
}
