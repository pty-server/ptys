import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, type IPty } from "node-pty";
import type { Terminal as TerminalType } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Session as SessionWire } from "@pty-server/protocol";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof TerminalType };
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: typeof SerializeAddonType;
};
const { Unicode11Addon } = require("@xterm/addon-unicode11") as {
  Unicode11Addon: new () => Parameters<TerminalType["loadAddon"]>[0];
};

export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly followSize: boolean;
  readonly everAttached: boolean;
  readonly environment: Record<string, string | undefined>;
  readonly pid: number;
  readonly cwd: string;
  readonly exited: SessionWire["exited"];
  markAttached(): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  rename(name: string): void;
  verifyEventToken(token: string | undefined): boolean;
  onTitleChange(callback: (title: string) => void): () => void;
  onData(callback: (chunk: string, seq: number) => void): () => void;
  onExit(callback: (event: { code: number; signal?: number; at: number }) => void): () => void;
  readonly currentSeq: number;
  snapshot(): Promise<string>;
  toJSON(): SessionWire;
}

export interface PtySessionOptions {
  id: string;
  workspaceId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  name?: string;
  followSize?: boolean;
  scrollback?: number;
  eventEndpoint?: string;
  eventToken?: string;
}

export class PtySession implements Session {
  readonly id: string;
  readonly workspaceId: string;
  name: string;
  readonly cmd: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly followSize: boolean;
  cols: number;
  rows: number;
  readonly createdAt: number;
  readonly cwd: string;
  readonly environment: Record<string, string | undefined>;
  readonly pty: IPty;
  exited: SessionWire["exited"];
  everAttached = false;
  private readonly eventToken?: string;

  private readonly term: TerminalType;
  private readonly serialize: SerializeAddonType;
  private sequence = 0;
  private readonly dataCallbacks = new Set<(chunk: string, seq: number) => void>();
  private readonly exitCallbacks = new Set<(event: { code: number; signal?: number; at: number }) => void>();
  private readonly titleCallbacks = new Set<(title: string) => void>();

  constructor(options: PtySessionOptions) {
    this.id = options.id;
    this.workspaceId = options.workspaceId;
    this.name = options.name ?? options.cmd;
    this.cmd = options.cmd;
    this.args = options.args ?? [];
    this.env = options.env ?? {};
    this.cols = options.cols;
    this.rows = options.rows;
    this.followSize = options.followSize ?? false;
    this.createdAt = Date.now();
    this.cwd = realpathSync(options.cwd);
    this.exited = undefined;
    this.eventToken = options.eventToken;
    const { PTYS_TOKEN: _token, PTYS_DAEMON: _daemon, ...parentEnvironment } = process.env;
    const eventEnvironment = options.eventEndpoint !== undefined && options.eventToken !== undefined
      ? { PTYS_EVENT_ENDPOINT: `${options.eventEndpoint}?token=${encodeURIComponent(options.eventToken)}` }
      : {};
    this.environment = { COLORTERM: "truecolor", TERM: "xterm-256color", ...parentEnvironment, ...this.env, ...eventEnvironment };
    this.pty = spawn(this.cmd, this.args, {
      cwd: this.cwd,
      env: this.environment,
      cols: this.cols,
      rows: this.rows,
      name: "xterm-256color",
    });

    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: options.scrollback ?? 5000,
      allowProposedApi: true,
    });
    this.serialize = new SerializeAddon();
    this.term.loadAddon(this.serialize);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.onTitleChange((title) => {
      for (const callback of this.titleCallbacks) callback(title);
    });

    this.pty.onData((chunk) => {
      const seq = ++this.sequence;
      this.term.write(chunk);
      for (const callback of this.dataCallbacks) {
        callback(chunk, seq);
      }
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = { code: exitCode, signal, at: Date.now() };
      const event = this.exited;
      for (const callback of this.exitCallbacks) {
        callback(event);
      }
    });
  }

  write(data: string | Buffer): void {
    if (this.exited === undefined) {
      this.pty.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.exited === undefined) {
      this.pty.resize(cols, rows);
    }
    this.term.resize(cols, rows);
  }

  kill(signal = "SIGTERM"): void {
    if (this.exited === undefined) {
      this.pty.kill(signal);
    }
  }

  rename(name: string): void {
    this.name = name;
  }

  markAttached(): void {
    this.everAttached = true;
  }

  verifyEventToken(token: string | undefined): boolean {
    if (token === undefined || token.length === 0 || this.eventToken === undefined) return false;
    const presented = createHash("sha256").update(token).digest();
    const actual = createHash("sha256").update(this.eventToken).digest();
    return timingSafeEqual(presented, actual);
  }

  get currentSeq(): number {
    return this.sequence;
  }

  get unicodeVersion(): string {
    return this.term.unicode.activeVersion;
  }

  snapshot(): Promise<string> {
    return new Promise((resolve) => {
      this.term.write("", () => {
        const body = this.serialize.serialize({ scrollback: 0 });
        const buf = this.term.buffer.active;
        const cup = `\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
        resolve(body + cup);
      });
    });
  }

  onData(callback: (chunk: string, seq: number) => void): () => void {
    this.dataCallbacks.add(callback);
    return () => this.dataCallbacks.delete(callback);
  }

  onExit(callback: (event: { code: number; signal?: number; at: number }) => void): () => void {
    this.exitCallbacks.add(callback);
    return () => this.exitCallbacks.delete(callback);
  }

  onTitleChange(callback: (title: string) => void): () => void {
    this.titleCallbacks.add(callback);
    return () => this.titleCallbacks.delete(callback);
  }

  get pid(): number {
    return this.pty.pid;
  }

  private get foregroundProcess(): string | undefined {
    if (this.exited !== undefined) return undefined;
    try {
      return this.pty.process;
    } catch {
      return undefined;
    }
  }

  toJSON(): SessionWire {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      name: this.name,
      cmd: this.cmd,
      args: this.args,
      env: this.env,
      cols: this.cols,
      rows: this.rows,
      followSize: this.followSize,
      createdAt: this.createdAt,
      pid: this.pid,
      cwd: this.cwd,
      process: this.foregroundProcess,
      exited: this.exited,
    };
  }
}
