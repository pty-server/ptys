import type { Listener } from "@pty-server/protocol";
import { ClientCommand, type ClientOptions } from "../client-command.js";
import { JSON_OPTION, type CommandContext, type OptionSpec } from "../command.js";
import { formatListenAddress, parseListenAddress } from "../../server/server-options.js";

export interface ListenCommandOptions extends ClientOptions {
  json?: boolean;
}

function printListeners(listeners: Listener[], json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(listeners));
  else for (const listener of listeners) console.log(formatListenAddress(listener));
}

abstract class ListenCommand<Args extends unknown[]> extends ClientCommand<Args, ListenCommandOptions> {
  readonly parentPath = ["config", "listen"];
  readonly extraOptions: OptionSpec[] = [JSON_OPTION];
  // Binding a network listener is exactly the privilege a network caller must not have, and the reply
  // carries the token, so the server registers these routes on the control socket alone.
  protected override readonly controlSocketOnly = true;
}

export class ListenListCommand extends ListenCommand<[]> {
  readonly name = "list";
  readonly description = "list the addresses this server is bound to";

  async run(ctx: CommandContext<[], ListenCommandOptions>): Promise<void> {
    const options = ctx.options;
    const listeners = await this.client(options).listListeners();
    printListeners(listeners, options.json);
  }
}

export class ListenAddCommand extends ListenCommand<[string]> {
  readonly name = "add <addr>";
  readonly description = "bind a TCP address, e.g. 127.0.0.1:7801";

  async run(ctx: CommandContext<[string], ListenCommandOptions>): Promise<void> {
    const [addr] = ctx.args;
    const options = ctx.options;
    const address = parseListenAddress(addr);
    const result = await this.client(options).addListener(address);
    if (options.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`listening on ${formatListenAddress(address)}`);
    if (result.token !== undefined) console.log(`token: ${result.token}`);
  }
}

export class ListenRemoveCommand extends ListenCommand<[string]> {
  readonly name = "remove <addr>";
  readonly description = "stop listening on a TCP address";

  async run(ctx: CommandContext<[string], ListenCommandOptions>): Promise<void> {
    const [addr] = ctx.args;
    const options = ctx.options;
    const address = parseListenAddress(addr);
    const listeners = await this.client(options).removeListener(address);
    if (options.json) console.log(JSON.stringify(listeners));
    else console.log(`stopped listening on ${formatListenAddress(address)}`);
  }
}
