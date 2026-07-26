import { runAttachClient } from "../attach-client.js";
import { ClientCommand } from "../client-command.js";
import { LOSSY_OPTION, type CommandContext, type OptionSpec } from "../command.js";
import { createSessionForCommand, sessionOptions, type SessionCreationOptions } from "./start.js";

export interface RunCommandOptions extends SessionCreationOptions {
  lossy?: boolean;
}

export class RunCommand extends ClientCommand<[string | undefined, string[]], RunCommandOptions> {
  readonly name = "run [cmd] [args...]";
  readonly description = "create a session and attach to it";
  readonly passThrough = true;
  readonly extraOptions: OptionSpec[] = [...sessionOptions(), LOSSY_OPTION];

  async run(ctx: CommandContext<[string | undefined, string[]], RunCommandOptions>): Promise<void> {
    const [cmd, args] = ctx.args;
    const options = ctx.options;
    const commandAndArgs = cmd === undefined ? [] : [cmd, ...args];
    const session = await createSessionForCommand(options, commandAndArgs, {
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    });

    process.stderr.write(`ptys: session ${session.id}\n`);
    await runAttachClient(session.id, {
      instance: options.instance,
      server: options.server,
      token: options.token,
      lossy: options.lossy,
      insecure: options.insecure,
      exactSessionId: true,
    });
  }
}
