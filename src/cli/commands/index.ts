import type { Command } from "commander";
import { AttachCommand } from "./attach.js";
import { EventListenerCommand } from "./event-listener.js";
import { EventCommand } from "./event.js";
import { KillCommand } from "./kill.js";
import { ListCommand } from "./list.js";
import { ListenAddCommand, ListenListCommand, ListenRemoveCommand } from "./listen.js";
import { OriginAllowCommand, OriginListCommand, OriginRemoveCommand } from "./origin.js";
import { RenameCommand } from "./rename.js";
import { RunCommand } from "./run.js";
import { ServerRestartCommand, ServerRunCommand, ServerStartCommand, ServerStatusCommand, ServerStopCommand } from "./server.js";
import { StartCommand } from "./start.js";

export const COMMANDS: { register(program: Command): void }[] = [
  new ServerRunCommand(),
  new ServerStartCommand(),
  new ServerStopCommand(),
  new ServerStatusCommand(),
  new ServerRestartCommand(),
  new StartCommand(),
  new RunCommand(),
  new ListCommand(),
  new KillCommand(),
  new RenameCommand(),
  new EventCommand(),
  new EventListenerCommand(),
  new OriginListCommand(),
  new OriginAllowCommand(),
  new OriginRemoveCommand(),
  new ListenListCommand(),
  new ListenAddCommand(),
  new ListenRemoveCommand(),
  new AttachCommand(),
];
