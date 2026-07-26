import { ApiClient } from "../api-client.js";
import { resolveTarget } from "../target.js";
import type { Session } from "@pty-server/protocol";
import { ClientCommand, type ClientOptions } from "../client-command.js";
import { appendValue, type CommandContext, type OptionSpec } from "../command.js";

export function sessionOptions(): OptionSpec[] {
  return [
    { flags: "--name <name>", description: "session name" },
    { flags: "--cwd <dir>", description: "starting directory" },
    { flags: "--env <k=v>", description: "environment variable", coerce: appendValue, default: [] },
    { flags: "--size <WxH>", description: "initial terminal size, e.g. 120x40" },
    { flags: "--follow-size", description: "session size follows the min size across attached read-write clients (old tmux-style min-dims arbitration)" },
  ];
}

export interface SessionCreationOptions extends ClientOptions {
  name?: string;
  cwd?: string;
  env: string[];
  size?: string;
  followSize?: boolean;
}

export interface StartCommandOptions extends SessionCreationOptions {}

function parseEnvironment(entries: string[]): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const entry of entries) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`Invalid environment value "${entry}"; expected K=V`);
    }
    environment[entry.slice(0, equalsIndex)] = entry.slice(equalsIndex + 1);
  }

  return environment;
}

function parseSize(value: string): { cols: number; rows: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) {
    throw new Error(`Invalid --size "${value}"; expected WxH, e.g. 120x40`);
  }
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols <= 0 || rows <= 0) {
    throw new Error(`Invalid --size "${value}"; expected WxH, e.g. 120x40`);
  }
  return { cols, rows };
}

export class StartCommand extends ClientCommand<[string | undefined, string[]], StartCommandOptions> {
  readonly name = "start [cmd] [args...]";
  readonly description = "create a session without attaching to it";
  readonly passThrough = true;
  readonly extraOptions: OptionSpec[] = sessionOptions();

  async run(ctx: CommandContext<[string | undefined, string[]], StartCommandOptions>): Promise<void> {
    const [cmd, args] = ctx.args;
    const options = ctx.options;
    const commandAndArgs = cmd === undefined ? [] : [cmd, ...args];
    const session = await createSessionForCommand(options, commandAndArgs, { cols: 80, rows: 24 });

    console.log(`started session ${session.id}`);
  }
}

export async function createSessionForCommand(
  options: SessionCreationOptions,
  commandAndArgs: string[],
  fallbackSize: { cols: number; rows: number },
): Promise<Session> {
  const [cmd, ...args] = commandAndArgs;

  const client = new ApiClient(resolveTarget(options));
  const workspaceId = options.cwd === undefined
    ? undefined
    : (await client.createWorkspace(options.cwd)).id;
  const { cols, rows } = options.size !== undefined ? parseSize(options.size) : fallbackSize;
  const session = await client.createSession({
    workspaceId,
    cmd,
    args,
    env: parseEnvironment(options.env),
    cols,
    rows,
    name: options.name,
    followSize: options.followSize,
  });

  return session;
}
