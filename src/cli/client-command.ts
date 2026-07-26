import { ApiClient } from "./api-client.js";
import { BaseCommand, type OptionSpec } from "./command.js";
import { resolveTarget } from "./target.js";

const INSTANCE_OPTION: OptionSpec = {
  flags: "--instance <name>",
  description: "local server instance to reach over its control socket (also PTYS_INSTANCE)",
};

export const CLIENT_OPTIONS: OptionSpec[] = [
  INSTANCE_OPTION,
  { flags: "--server <addr>", description: "address of a remote server, reached with a token" },
  { flags: "--insecure", description: "allow plaintext http:// to a non-loopback server (also PTYS_INSECURE=1)" },
  { flags: "--token <token>", description: "auth token" },
];

export interface ClientOptions {
  instance?: string;
  server?: string;
  insecure?: boolean;
  token?: string;
}

export abstract class ClientCommand<Args extends unknown[] = unknown[], Opts extends ClientOptions = ClientOptions> extends BaseCommand<Args, Opts> {
  abstract readonly extraOptions: OptionSpec[];

  /**
   * Set by commands whose routes the server answers only over the control socket, so they neither
   * advertise nor accept the remote options.
   */
  protected readonly controlSocketOnly: boolean = false;

  get options(): OptionSpec[] {
    return [...(this.controlSocketOnly ? [INSTANCE_OPTION] : CLIENT_OPTIONS), ...this.extraOptions];
  }

  protected client(options: ClientOptions): ApiClient {
    if (this.controlSocketOnly) {
      const server = options.server ?? process.env.PTYS_SERVER;
      if ((server !== undefined && server.length > 0) || options.token !== undefined || options.insecure === true) {
        const label = this.parentPath?.join(" ") ?? this.name;
        throw new Error(`ptys: ${label} is only accepted over the control socket; use --instance, not --server`);
      }
    }
    return new ApiClient(resolveTarget(options));
  }
}
