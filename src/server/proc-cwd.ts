import { execFile } from "node:child_process";
import { readlink, stat } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const LSOF_TIMEOUT_MS = 1000;

async function readProcCwd(pid: number): Promise<string> {
  return readlink(`/proc/${pid}/cwd`);
}

async function readLsofCwd(pid: number): Promise<string> {
  const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { timeout: LSOF_TIMEOUT_MS });
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("n"));
  if (line === undefined) throw new Error(`lsof reported no cwd for pid ${pid}`);
  return line.slice(1);
}

export async function resolveLiveCwd(pid: number, fallback: string): Promise<string> {
  if (process.platform !== "linux" && process.platform !== "darwin") return fallback;
  try {
    const live = process.platform === "linux" ? await readProcCwd(pid) : await readLsofCwd(pid);
    return (await stat(live)).isDirectory() ? live : fallback;
  } catch {
    return fallback;
  }
}
