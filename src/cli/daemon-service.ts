import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { getOrCreateToken } from "../server/auth.js";
import { startServer } from "../server/index.js";
import { canonicalizeBrowseRoots } from "../server/directory-browser.js";
import { DEFAULT_MAX_CLOSED_SESSIONS } from "../server/session-manager.js";
import { formatListenAddress, parseListenAddress, validateServerOptions, type ListenAddress } from "../server/server-options.js";
import { readServerDefaults } from "./config.js";
import { DEFAULT_INSTANCE, validateInstanceName } from "../paths.js";
import { isAlive, isDaemonAlive, listDaemons, logPath, readPidfile, removePidfile, runDir, type PidfileData, type RunningOptions, writePidfile } from "./daemon.js";

export interface ServerCommandOptions {
  instance?: string;
  listen?: string[];
  token?: string;
  auth?: boolean;
  authExplicit?: boolean;
  allowOrigin?: string[];
  scrollback?: number;
  browseRoot?: string[];
  maxClosedSessions?: number;
  shell?: string;
  disableExec?: boolean;
}

export interface ServerConfig {
  instance: string;
  running: Omit<RunningOptions, "token">;
}

export interface ForegroundServer {
  instance: string;
  serverId: string;
  transports: string[];
}

export type StartOutcome =
  | { kind: "started"; instance: string; pid: number; logPath: string }
  | { kind: "already-running"; instance: string; pid: number }
  | { kind: "unsupported-platform" }
  | { kind: "failed"; logTail: string };

export type StopOutcome = "stopped" | "absent" | "stale";

export interface StopReport {
  instance: string;
  pid?: number;
  outcome: StopOutcome;
}

export type RestartOutcome =
  | { kind: "not-running"; instance: string }
  | { kind: "restarted"; instance: string; pid: number; stale: boolean; start: StartOutcome };

export interface DaemonStatus {
  instance: string;
  listen: string[];
  pid: number;
  status: string;
  alive: boolean;
  uptime: string;
  logPath: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Effective settings come from CLI options over `~/.ptys.json`. Validation happens here, before a token
 * file, a child process or any listener exists, so an invalid setting can never leave state behind.
 */
export function resolveServerConfig(options: ServerCommandOptions): ServerConfig {
  const defaults = readServerDefaults();
  const instance = options.instance ?? defaults.instance ?? DEFAULT_INSTANCE;
  const listen = (options.listen ?? defaults.listen ?? []).map(parseListenAddress);
  const noAuth = options.authExplicit ? options.auth === false : defaults.noAuth ?? false;
  const allowOrigins = options.allowOrigin ?? defaults.allowOrigins ?? [];
  const scrollback = options.scrollback ?? defaults.scrollback ?? 5000;
  const maxClosedSessions = options.maxClosedSessions ?? defaults.maxClosedSessions ?? DEFAULT_MAX_CLOSED_SESSIONS;
  const shell = options.shell ?? defaults.shell;
  const disableExec = options.disableExec ?? defaults.disableExec ?? false;

  validateServerOptions({ instance, listen, noAuth, allowOrigins, scrollback, maxClosedSessions, shell, disableExec });

  return {
    instance,
    running: {
      listen,
      noAuth,
      allowOrigins,
      scrollback,
      browseRoots: canonicalizeBrowseRoots(options.browseRoot ?? defaults.browseRoots),
      maxClosedSessions,
      ...(shell === undefined ? {} : { shell }),
      disableExec,
    },
  };
}

export function selectedInstance(flagValue: string | undefined): string {
  const instance = flagValue ?? readServerDefaults().instance ?? DEFAULT_INSTANCE;
  validateInstanceName(instance);
  return instance;
}

function waitForDaemonReady(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(ready);
    };
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null) return;
      if ((message as { type?: unknown }).type !== "ptys.daemon.ready") return;
      settle(true);
    };
    const onExit = (): void => settle(false);
    const onError = (): void => settle(false);
    const timeout = setTimeout(() => settle(false), 2000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function logTail(path: string): string {
  try { return readFileSync(path, "utf8").trim().split("\n").slice(-20).join("\n"); } catch { return ""; }
}

async function launchDaemon(input: { instance: string; running: RunningOptions }): Promise<StartOutcome> {
  const { instance, running } = input;
  const { listen, noAuth, allowOrigins, scrollback, browseRoots, maxClosedSessions, shell, disableExec, token } = running;
  const existing = readPidfile(instance);
  if (existing !== undefined && await isDaemonAlive(existing)) {
    return { kind: "already-running", instance, pid: existing.pid };
  }

  const path = logPath(instance);
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const logFd = openSync(path, "a", 0o600);
  const flags = ["server", "--instance", instance, ...listen.flatMap((address) => ["--listen", formatListenAddress(address)]), ...(noAuth ? ["--no-auth"] : []),...allowOrigins.flatMap((origin) => ["--allow-origin", origin]), ...browseRoots.flatMap((root) => ["--browse-root", root]), "--scrollback", String(scrollback), "--max-closed-sessions", String(maxClosedSessions), ...(shell === undefined ? [] : ["--shell", shell]), ...(disableExec === true ? ["--disable-exec"] : [])];
  const child = spawn(process.execPath, [process.argv[1], ...flags], {
    detached: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
    env: { ...process.env, PTYS_DAEMON: "1", ...(token === undefined ? {} : { PTYS_TOKEN: token }) },
  });
  closeSync(logFd);
  child.unref();
  if (child.pid === undefined) throw new Error("failed to spawn daemon");

  // The daemon writes its own pidfile once it owns the control socket, so a start that loses the instance
  // never publishes one and can only ever remove its own.
  const ready = await waitForDaemonReady(child);
  if (child.connected) {
    child.disconnect();
  }
  if (ready && isAlive(child.pid)) {
    return { kind: "started", instance, pid: child.pid, logPath: path };
  }
  removePidfile(instance, child.pid);
  return { kind: "failed", logTail: logTail(path) };
}

function recordListenChange(instance: string, addresses: ListenAddress[]): void {
  if (process.env.PTYS_DAEMON !== "1") return;
  const data = readPidfile(instance);
  if (data?.pid !== process.pid) return;
  writePidfile({ ...data, listen: addresses });
}

/**
 * Runs the server in this process and, when it is a daemon, publishes the instance: pidfile write, readiness
 * message and signal handling all belong to the process that owns the control socket.
 */
export async function startForeground(config: ServerConfig, token: string | undefined): Promise<ForegroundServer> {
  const { instance, running } = config;
  const { listen, noAuth, allowOrigins, scrollback, browseRoots, maxClosedSessions, shell, disableExec } = running;
  const started = await startServer({
    instance,
    listen,
    token,
    noAuth,
    allowOrigins,
    scrollback,
    browseRoots,
    maxClosedSessions,
    ...(shell === undefined ? {} : { shell }),
    disableExec,
    onListenChange: (addresses) => recordListenChange(instance, addresses),
  });

  if (process.env.PTYS_DAEMON === "1") {
    // Owning the control socket is what makes this process the instance, so it is also what entitles it
    // to describe the instance in the pidfile.
    const effectiveToken = token ?? process.env.PTYS_TOKEN;
    writePidfile({
      pid: process.pid,
      instance,
      startedAt: Date.now(),
      logPath: logPath(instance),
      running: { ...running, ...(effectiveToken === undefined || effectiveToken.length === 0 ? {} : { token: effectiveToken }) },
      ...(started.controlSocketPath === undefined ? {} : { controlSocketPath: started.controlSocketPath }),
    });
  }
  try {
    process.send?.({ type: "ptys.daemon.ready" });
  } catch {
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void started.close().finally(() => {
      if (process.env.PTYS_DAEMON === "1") {
        removePidfile(instance, process.pid);
      }
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return {
    instance,
    serverId: started.serverId,
    transports: [
      ...(started.controlSocketPath === undefined ? [] : [`unix:${started.controlSocketPath}`]),
      ...listen.map((address) => `http://${formatListenAddress(address)}`),
    ],
  };
}

export async function startBackground(options: ServerCommandOptions): Promise<StartOutcome> {
  if (process.platform === "win32") {
    return { kind: "unsupported-platform" };
  }
  const config = resolveServerConfig(options);
  const token = config.running.noAuth || config.running.listen.length === 0
    ? undefined
    : getOrCreateToken(options.token);
  return launchDaemon({ ...config, running: { ...config.running, token } });
}

async function stopInstance(data: PidfileData): Promise<StopOutcome> {
  if (!await isDaemonAlive(data)) {
    const foreign = isAlive(data.pid);
    removePidfile(data.instance, data.pid);
    return foreign ? "stale" : "absent";
  }
  process.kill(data.pid, "SIGTERM");
  for (let elapsed = 0; elapsed < 5000 && await isDaemonAlive(data); elapsed += 75) await delay(75);
  if (await isDaemonAlive(data)) process.kill(data.pid, "SIGKILL");
  for (let elapsed = 0; elapsed < 2000 && isAlive(data.pid); elapsed += 25) await delay(25);
  removePidfile(data.instance, data.pid);
  return "stopped";
}

export async function stopDaemons(input: { instance: string; all: boolean }): Promise<StopReport[]> {
  const daemons = input.all ? listDaemons() : (() => {
    const data = readPidfile(input.instance);
    return data === undefined ? [] : [data];
  })();
  if (daemons.length === 0 && !input.all) {
    return [{ instance: input.instance, outcome: "absent" }];
  }
  const reports: StopReport[] = [];
  for (const daemon of daemons) {
    reports.push({ instance: daemon.instance, pid: daemon.pid, outcome: await stopInstance(daemon) });
  }
  return reports;
}

export async function restartDaemon(instance: string): Promise<RestartOutcome> {
  const daemon = readPidfile(instance);
  if (daemon === undefined) {
    return { kind: "not-running", instance };
  }
  const stale = await stopInstance(daemon) === "stale";
  const { listen, noAuth, allowOrigins, scrollback, maxClosedSessions, shell, disableExec } = daemon.running;
  validateServerOptions({ instance: daemon.instance, listen, noAuth, allowOrigins, scrollback, maxClosedSessions, shell, disableExec });
  return {
    kind: "restarted",
    instance: daemon.instance,
    pid: daemon.pid,
    stale,
    start: await launchDaemon({ instance: daemon.instance, running: daemon.running }),
  };
}

function uptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * Describing a daemon also prunes it: a pidfile whose daemon no longer answers on its control socket is
 * removed here, so status is the one read path that reconciles the instance registry with reality.
 */
export async function describeDaemons(instance: string | undefined): Promise<DaemonStatus[]> {
  const filtered = listDaemons().filter((daemon) => instance === undefined || daemon.instance === instance);
  return Promise.all(filtered.map(async (daemon) => {
    const alive = await isDaemonAlive(daemon);
    if (!alive) removePidfile(daemon.instance, daemon.pid);
    return {
      instance: daemon.instance,
      listen: (daemon.listen ?? daemon.running.listen).map(formatListenAddress),
      pid: daemon.pid,
      status: alive ? "alive" : "stale",
      alive,
      uptime: uptime(Date.now() - daemon.startedAt),
      logPath: daemon.logPath,
    };
  }));
}
