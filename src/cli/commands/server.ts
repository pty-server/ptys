import { appendValue, JSON_OPTION, type CommandContext, type OptionSpec } from "../command.js";
import { ServerCommand } from "../server-command.js";
import {
  describeDaemons,
  resolveServerConfig,
  restartDaemon,
  selectedInstance,
  startBackground,
  startForeground,
  stopDaemons,
  type ServerCommandOptions,
  type StartOutcome,
} from "../daemon-service.js";

const SERVER_DAEMON_OPTIONS: OptionSpec[] = [
  { flags: "--instance <name>", description: "instance name, which names this server's pidfile, log and control socket" },
  { flags: "--listen <addr>", description: "bind a TCP address, e.g. 127.0.0.1:7801 (repeatable; omit for control socket only)", coerce: appendValue },
  { flags: "--token <token>", description: "auth token" },
  { flags: "--no-auth", description: "disable auth (refuses to start unless the bind host is loopback)" },
  { flags: "--allow-origin <origin>", description: "allow a WS Origin (repeatable)", coerce: appendValue },
  { flags: "--browse-root <path>", description: "directory root exposed to clients (repeatable)", coerce: appendValue },
  { flags: "--shell <path>", description: "shell for sessions that do not name a command (default: this user's passwd shell)" },
  { flags: "--disable-exec", description: "remove POST /v1/sessions/:id/exec, which otherwise runs commands as this user" },
  { flags: "--scrollback <n>", description: "scrollback lines per session", coerce: (value) => Number(value) },
  { flags: "--max-closed-sessions <n>", description: "closed sessions to retain", coerce: (value) => Number(value) },
];

export interface ServerStopOptions { instance?: string; all?: boolean }
export interface ServerStatusOptions { instance?: string; json?: boolean }
export interface ServerRestartOptions { instance?: string }

function instanceOption(verb: string): OptionSpec[] {
  return [
    { flags: "--instance <name>", description: `instance to ${verb}` },
  ];
}

function reportStart(outcome: StartOutcome): void {
  switch (outcome.kind) {
    case "started":
      console.log(`ptys: daemon started as instance ${outcome.instance} (pid ${outcome.pid}), logs: ${outcome.logPath}`);
      return;
    case "already-running":
      console.error(`ptys: daemon already running as instance ${outcome.instance} (pid ${outcome.pid})`);
      process.exitCode = 1;
      return;
    case "unsupported-platform":
      console.error("ptys: daemon mode is unsupported on Windows; use a service manager");
      process.exitCode = 1;
      return;
    case "failed":
      console.error(`ptys: daemon failed to start:${outcome.logTail.length > 0 ? `\n${outcome.logTail}` : ""}`);
      process.exitCode = 1;
  }
}

export class ServerRunCommand extends ServerCommand<[], ServerCommandOptions> {
  readonly name = "run";
  readonly description = "run the server in the foreground";
  readonly isDefault = true;
  get options(): OptionSpec[] { return SERVER_DAEMON_OPTIONS; }

  async run(ctx: CommandContext<[], ServerCommandOptions>): Promise<void> {
    const options = { ...ctx.options, authExplicit: ctx.command.getOptionValueSource("auth") === "cli" };
    // Settings are resolved outside the catch: an invalid setting is a usage error, not a failed start.
    const config = resolveServerConfig(options);
    try {
      const server = await startForeground(config, options.token);
      const identity = ` (instance=${server.instance} serverId=${server.serverId})`;
      server.transports.forEach((transport, index) => {
        console.log(`ptys server listening on ${transport}${index === 0 ? identity : ""}`);
      });
    } catch (error) {
      console.error(`Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

export class ServerStartCommand extends ServerCommand<[], ServerCommandOptions> {
  readonly name = "start";
  readonly description = "start the server as a background daemon";
  get options(): OptionSpec[] { return SERVER_DAEMON_OPTIONS; }

  async run(ctx: CommandContext<[], ServerCommandOptions>): Promise<void> {
    reportStart(await startBackground({ ...ctx.options, authExplicit: ctx.command.getOptionValueSource("auth") === "cli" }));
  }
}

export class ServerStopCommand extends ServerCommand<[], ServerStopOptions> {
  readonly name = "stop";
  readonly description = "stop a running daemon";
  get options(): OptionSpec[] {
    return [
      ...instanceOption("stop"),
      { flags: "--all", description: "stop all daemons" },
    ];
  }

  async run(ctx: CommandContext<[], ServerStopOptions>): Promise<void> {
    const all = ctx.options.all === true;
    const reports = await stopDaemons({ instance: selectedInstance(ctx.options.instance), all });
    for (const report of reports) {
      if (report.outcome === "stopped") {
        console.log(`ptys: stopped daemon ${report.instance} (pid ${report.pid})`);
        continue;
      }
      if (report.outcome === "stale") {
        console.error(`ptys: stale pidfile for instance ${report.instance} (pid ${report.pid} is not this daemon); removed it without signalling`);
        process.exitCode = 1;
        continue;
      }
      if (!all) {
        console.error(`ptys: no daemon running as instance ${report.instance}`);
        process.exitCode = 1;
      }
    }
  }
}

export class ServerStatusCommand extends ServerCommand<[], ServerStatusOptions> {
  readonly name = "status";
  readonly description = "show running daemons";
  get options(): OptionSpec[] {
    return [
      ...instanceOption("inspect"),
      JSON_OPTION,
    ];
  }

  async run(ctx: CommandContext<[], ServerStatusOptions>): Promise<void> {
    const statuses = await describeDaemons(ctx.options.instance);
    if (ctx.options.json) {
      console.log(JSON.stringify(statuses));
      return;
    }
    for (const status of statuses) {
      const listen = status.listen.length === 0 ? "socket-only" : status.listen.join(",");
      console.log(`${status.instance} ${listen} pid ${status.pid} ${status.status} uptime ${status.uptime} logs: ${status.logPath}`);
    }
  }
}

export class ServerRestartCommand extends ServerCommand<[], ServerRestartOptions> {
  readonly name = "restart";
  readonly description = "restart a running daemon";
  get options(): OptionSpec[] {
    return instanceOption("restart");
  }

  async run(ctx: CommandContext<[], ServerRestartOptions>): Promise<void> {
    const outcome = await restartDaemon(selectedInstance(ctx.options.instance));
    if (outcome.kind === "not-running") {
      console.error(`ptys: no daemon running as instance ${outcome.instance}`);
      process.exitCode = 1;
      return;
    }
    if (outcome.stale) {
      console.error(`ptys: stale pidfile for instance ${outcome.instance} (pid ${outcome.pid} is not this daemon); starting a new daemon without signalling it`);
    }
    reportStart(outcome.start);
  }
}
