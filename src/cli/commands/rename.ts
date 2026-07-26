import { ClientCommand, type ClientOptions } from "../client-command.js";
import { type CommandContext, type OptionSpec } from "../command.js";
import { resolveSessionId } from "../session-resolver.js";

export type RenameCommandOptions = ClientOptions;

export class RenameCommand extends ClientCommand<[string, string], RenameCommandOptions> {
  readonly name = "rename <sessionId> <name>";
  readonly description = "rename a session";
  readonly extraOptions: OptionSpec[] = [];

  async run(ctx: CommandContext<[string, string], RenameCommandOptions>): Promise<void> {
    const [sessionIdOrPrefixOrName, name] = ctx.args;
    const options = ctx.options;
    const client = this.client(options);
    const sessionId = await resolveSessionId(client, undefined, sessionIdOrPrefixOrName);
    const session = await client.renameSession(sessionId, name);
    console.log(`renamed session ${session.id} to ${session.name}`);
  }
}
