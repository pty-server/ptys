import { spawn } from "node:child_process";
import type { ExecSessionResponse } from "@pty-server/protocol";

export const DEFAULT_EXEC_TIMEOUT_MS = 5000;
export const EXEC_KILL_GRACE_MS = 2000;
export const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
export const MAX_EXECS_PER_SESSION = 4;
export const MAX_EXECS_TOTAL = 16;

export class ExecBusyError extends Error {
  constructor(readonly scope: "session" | "server") {
    super(`too many concurrent commands for this ${scope}`);
    this.name = "ExecBusyError";
  }
}

export interface ExecInput {
  cmd: string;
  args?: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
}

type ExecOutcome = Omit<ExecSessionResponse, "cwd" | "durationMs">;

class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  append(chunk: Buffer): void {
    const room = MAX_EXEC_OUTPUT_BYTES - this.size;
    if (chunk.length > room) this.truncated = true;
    if (room <= 0) return;
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export class ExecRunner {
  private readonly perSession = new Map<string, number>();
  private total = 0;

  async run(sessionId: string, input: ExecInput): Promise<ExecSessionResponse> {
    this.acquire(sessionId);
    const startedAt = Date.now();
    try {
      const outcome = await this.execute(input);
      return { ...outcome, cwd: input.cwd, durationMs: Date.now() - startedAt };
    } finally {
      this.release(sessionId);
    }
  }

  private acquire(sessionId: string): void {
    if (this.total >= MAX_EXECS_TOTAL) throw new ExecBusyError("server");
    const running = this.perSession.get(sessionId) ?? 0;
    if (running >= MAX_EXECS_PER_SESSION) throw new ExecBusyError("session");
    this.perSession.set(sessionId, running + 1);
    this.total += 1;
  }

  private release(sessionId: string): void {
    const running = (this.perSession.get(sessionId) ?? 1) - 1;
    if (running <= 0) this.perSession.delete(sessionId);
    else this.perSession.set(sessionId, running);
    this.total -= 1;
  }

  private execute(input: ExecInput): Promise<ExecOutcome> {
    return new Promise((resolve) => {
      const stdout = new OutputBuffer();
      const stderr = new OutputBuffer();
      let timedOut = false;
      let settled = false;
      let spawnFailure: string | undefined;
      let grace: NodeJS.Timeout | undefined;

      const child = spawn(input.cmd, input.args ?? [], {
        cwd: input.cwd,
        env: input.env,
        windowsHide: true,
      });

      const expiry = setTimeout(() => {
        timedOut = true;
        terminate();
      }, input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);

      const settle = (code: number | null, signal?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(expiry);
        if (grace !== undefined) clearTimeout(grace);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        const reported = stderr.text();
        resolve({
          code,
          ...(signal === undefined ? {} : { signal }),
          stdout: stdout.text(),
          stderr: reported.length === 0 && spawnFailure !== undefined ? spawnFailure : reported,
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
        });
      };

      const terminate = (): void => {
        if (settled || grace !== undefined) return;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        grace = setTimeout(() => {
          child.kill("SIGKILL");
          settle(null, "SIGKILL");
        }, EXEC_KILL_GRACE_MS);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
        if (stdout.truncated) terminate();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
        if (stderr.truncated) terminate();
      });
      child.on("error", (error) => {
        spawnFailure = error.message;
        settle(null);
      });
      child.on("close", (code, signal) => settle(code, signal ?? undefined));

      child.stdin?.on("error", () => {});
      child.stdin?.end(input.stdin ?? "");
    });
  }
}