import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { logPath, pidPath, runDir } from "../paths.js";
import type { ListenAddress } from "../server/server-options.js";

export { logPath, pidPath, runDir };

export interface RunningOptions {
  listen: ListenAddress[];
  noAuth: boolean;
  allowOrigins: string[];
  scrollback: number;
  browseRoots: string[];
  maxClosedSessions: number;
  token?: string;
}

export interface PidfileData {
  pid: number;
  instance: string;
  listen?: ListenAddress[];
  startedAt: number;
  logPath: string;
  running: RunningOptions;
  controlSocketPath?: string;
}

function isListenArray(value: unknown): value is ListenAddress[] {
  return Array.isArray(value) && value.every((address) =>
    typeof address === "object" && address !== null &&
    typeof (address as ListenAddress).host === "string" && typeof (address as ListenAddress).port === "number");
}

function isPidfileData(value: unknown): value is PidfileData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as PidfileData;
  return typeof data.pid === "number" && typeof data.instance === "string" &&
    (data.listen === undefined || isListenArray(data.listen)) &&
    typeof data.startedAt === "number" && typeof data.logPath === "string" &&
    typeof data.running === "object" && data.running !== null &&
    isListenArray(data.running.listen) &&
    typeof data.running.noAuth === "boolean" &&
    Array.isArray(data.running.allowOrigins) && data.running.allowOrigins.every((origin) => typeof origin === "string") &&
    typeof data.running.scrollback === "number" && Array.isArray(data.running.browseRoots) &&
    data.running.browseRoots.every((root) => typeof root === "string") &&
    typeof data.running.maxClosedSessions === "number" && Number.isSafeInteger(data.running.maxClosedSessions) && data.running.maxClosedSessions >= 0 &&
    (data.running.token === undefined || typeof data.running.token === "string") &&
    (data.controlSocketPath === undefined || typeof data.controlSocketPath === "string");
}

export function readPidfile(instance: string): PidfileData | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(pidPath(instance), "utf8"));
    if (isPidfileData(value)) return value;
  } catch {
  }
  return undefined;
}

export function writePidfile(data: PidfileData): void {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pidPath(data.instance), JSON.stringify(data), { mode: 0o600 });
}

/**
 * With `pid`, the pidfile is removed only while it still describes that process: a start that lost the
 * instance to a concurrent one must never delete the winner's pidfile.
 */
export function removePidfile(instance: string, pid?: number): void {
  if (pid !== undefined && readPidfile(instance)?.pid !== pid) return;
  rmSync(pidPath(instance), { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

const IDENTITY_TIMEOUT_MS = 1000;

function daemonIdentity(socketPath: string): Promise<{ pid: number } | undefined> {
  return new Promise((resolve) => {
    const call = request({ socketPath, path: "/v1/daemon", method: "GET", timeout: IDENTITY_TIMEOUT_MS }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(body) as { pid?: unknown };
          resolve(typeof parsed.pid === "number" ? { pid: parsed.pid } : undefined);
        } catch {
          resolve(undefined);
        }
      });
      response.on("error", () => resolve(undefined));
    });
    call.on("error", () => resolve(undefined));
    call.on("timeout", () => {
      call.destroy();
      resolve(undefined);
    });
    call.end();
  });
}

export async function isDaemonAlive(data: PidfileData): Promise<boolean> {
  if (data.controlSocketPath === undefined) {
    return false;
  }
  const identity = await daemonIdentity(data.controlSocketPath);
  return identity?.pid === data.pid;
}

export function listDaemons(): PidfileData[] {
  if (!existsSync(runDir())) return [];
  return readdirSync(runDir())
    .filter((name) => name.endsWith(".pid"))
    .flatMap((name) => {
      try {
        const value: unknown = JSON.parse(readFileSync(join(runDir(), name), "utf8"));
        return isPidfileData(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}
