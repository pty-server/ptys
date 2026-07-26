import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";


export const DEFAULT_INSTANCE = "default";

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateInstanceName(name: string): void {
  if (!INSTANCE_NAME.test(name)) {
    throw new Error(
      "instance must start with a letter or digit and contain only letters, digits, dots, dashes and underscores (max 64 characters)",
    );
  }
}

export function stateDir(): string {
  return join(homedir(), ".ptys");
}

export function runDir(): string {
  return join(stateDir(), "run");
}

export function pidPath(instance: string): string {
  return join(runDir(), `${instance}.pid`);
}

export function logPath(instance: string): string {
  return join(runDir(), `${instance}.log`);
}

export const SOCKET_PATH_LIMIT = 100;

export function socketDirCandidates(): string[] {
  const override = process.env.PTYS_SOCKET_DIR;
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return [
    runDir(),
    ...(runtimeDir === undefined || runtimeDir.length === 0 ? [] : [join(runtimeDir, "ptys")]),
    join(tmpdir(), `ptys-${userInfo().uid}`),
  ];
}

export function controlSocketCandidates(instance: string): string[] {
  return socketDirCandidates().map((dir) => join(dir, `${instance}.sock`));
}
