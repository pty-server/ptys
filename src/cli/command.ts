import { type Command } from "commander";

export interface OptionSpec {
  flags: string;
  description: string;
  default?: unknown;
  coerce?: (value: string, previous: unknown) => unknown;
}

export interface CommandContext<Args extends unknown[] = unknown[], Opts = Record<string, unknown>> {
  args: Args;
  options: Opts;
  command: Command;
}

const groups = new WeakMap<Command, Map<string, Command>>();

export const GROUP_DESCRIPTIONS: Record<string, string> = {
  server: "manage the ptys server daemon",
  config: "inspect and change server configuration",
  "config origin": "manage allowed WebSocket origins",
  "config listen": "manage the TCP addresses a running server is bound to",
};

function ensureGroup(program: Command, parentPath: string[]): Command {
  const programGroups = groups.get(program) ?? new Map<string, Command>();
  groups.set(program, programGroups);
  let parent = program;
  const path: string[] = [];
  for (const segment of parentPath) {
    path.push(segment);
    const key = path.join("\u0000");
    const existing = programGroups.get(key);
    if (existing !== undefined) {
      parent = existing;
      continue;
    }
    parent = parent.command(segment);
    const description = GROUP_DESCRIPTIONS[path.join(" ")];
    if (description !== undefined) parent.description(description);
    programGroups.set(key, parent);
  }
  return parent;
}

export function reportError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function appendValue(value: string, previous: unknown = []): string[] {
  return [...(previous as string[]), value];
}

export const JSON_OPTION: OptionSpec = { flags: "--json", description: "print JSON" };
export const LOSSY_OPTION: OptionSpec = { flags: "--lossy", description: "opt this read-write attach into coalescing under backpressure (may drop frames under load)" };

export abstract class BaseCommand<Args extends unknown[] = unknown[], Opts = Record<string, unknown>> {
  abstract readonly name: string;
  readonly description?: string;
  readonly parentPath?: string[];
  get options(): OptionSpec[] { return []; }
  readonly isDefault?: boolean;
  readonly passThrough?: boolean;

  abstract run(ctx: CommandContext<Args, Opts>): Promise<void>;

  register(program: Command): void {
    const parent = this.parentPath === undefined ? program : ensureGroup(program, this.parentPath);
    const command = parent.command(this.name, this.isDefault ? { isDefault: true } : undefined);
    for (const option of this.options) {
      if (option.coerce !== undefined && option.default !== undefined) {
        command.option(option.flags, option.description, option.coerce, option.default);
      } else if (option.coerce !== undefined) {
        command.option(option.flags, option.description, option.coerce);
      } else if (option.default !== undefined) {
        command.option(option.flags, option.description, option.default as string | boolean | string[]);
      } else {
        command.option(option.flags, option.description);
      }
    }
    if (this.description !== undefined) command.description(this.description);
    if (this.passThrough) command.passThroughOptions();
    command.action((...all: unknown[]) =>
      this.run({
        args: all.slice(0, -2) as Args,
        options: all[all.length - 2] as Opts,
        command: all[all.length - 1] as Command,
      }).catch(reportError));
  }
}
