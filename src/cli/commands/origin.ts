import { ClientCommand, type ClientOptions } from "../client-command.js";
import { JSON_OPTION, type CommandContext, type OptionSpec } from "../command.js";

export interface OriginCommandOptions extends ClientOptions {
  json?: boolean;
}

function printOrigins(origins: string[], json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(origins));
  else for (const origin of origins) console.log(origin);
}

abstract class OriginCommand<Args extends unknown[]> extends ClientCommand<Args, OriginCommandOptions> {
  readonly parentPath = ["config", "origin"];
  readonly extraOptions: OptionSpec[] = [JSON_OPTION];
}

export class OriginListCommand extends OriginCommand<[]> {
  readonly name = "list";
  readonly description = "list allowed origins";

  async run(ctx: CommandContext<[], OriginCommandOptions>): Promise<void> {
    const options = ctx.options;
    printOrigins(await this.client(options).listOrigins(), options.json);
  }
}

export class OriginAllowCommand extends OriginCommand<[string]> {
  readonly name = "allow <origin>";
  readonly description = "allow a WebSocket origin";

  async run(ctx: CommandContext<[string], OriginCommandOptions>): Promise<void> {
    const [origin] = ctx.args;
    const options = ctx.options;
    const origins = await this.client(options).allowOrigin(origin);
    if (options.json) console.log(JSON.stringify(origins));
    else console.log(`allowed origin ${origin}`);
  }
}

export class OriginRemoveCommand extends OriginCommand<[string]> {
  readonly name = "remove <origin>";
  readonly description = "remove an allowed origin";

  async run(ctx: CommandContext<[string], OriginCommandOptions>): Promise<void> {
    const [origin] = ctx.args;
    const options = ctx.options;
    const origins = await this.client(options).removeOrigin(origin);
    if (options.json) console.log(JSON.stringify(origins));
    else console.log(`removed origin ${origin}`);
  }
}
