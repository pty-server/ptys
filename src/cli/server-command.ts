import { BaseCommand } from "./command.js";

export abstract class ServerCommand<Args extends unknown[] = unknown[], Opts = Record<string, unknown>> extends BaseCommand<Args, Opts> {
  readonly parentPath: string[] = ["server"];
}
