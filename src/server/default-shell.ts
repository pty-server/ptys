import { userInfo } from "node:os";

/** Injection seam for the fallback chain; production callers pass nothing. */
export interface ShellLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  passwdShell?: () => string | undefined;
}

function nonEmpty(value: string | undefined | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function passwdShell(): string | undefined {
  try {
    return nonEmpty(userInfo().shell);
  } catch {
    // No passwd entry for this uid, which containers do produce.
    return undefined;
  }
}

/**
 * passwd before `SHELL`, because the server outlives the terminal that started it: a daemon detaches and
 * never refreshes its environment, so its `SHELL` is a snapshot of whichever shell happened to launch it
 * (an npm lifecycle script or a launchd wrapper hands out `/bin/sh` forever), while passwd stays live.
 */
export function resolveDefaultShell(override?: string, lookup: ShellLookup = {}): string {
  const explicit = nonEmpty(override);
  if (explicit !== undefined) return explicit;

  const env = lookup.env ?? process.env;
  if ((lookup.platform ?? process.platform) === "win32") return nonEmpty(env.ComSpec) ?? "cmd.exe";
  return (lookup.passwdShell ?? passwdShell)() ?? nonEmpty(env.SHELL) ?? "/bin/sh";
}
