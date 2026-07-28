import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const EXECUTABLE_BITS = 0o111;

/**
 * node-pty publishes `prebuilds/<platform>-<arch>/spawn-helper` with mode 0644, and macOS execs that
 * binary for every session, so an unrepaired install fails every spawn with `posix_spawnp failed`.
 * Repairing it is this package's job because the mode is lost on every reinstall of the dependency.
 */
function prebuildsDir(): string | undefined {
  try {
    // node-pty is never bundled, so this resolves against the real install even from dist/cli.js.
    return join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
  } catch {
    return undefined;
  }
}

/** Every spawn helper in the install, whichever platform it was prebuilt for. */
export function spawnHelperPaths(): string[] {
  const dir = prebuildsDir();
  if (dir === undefined) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.map((entry) => join(dir, entry, "spawn-helper")).filter((path) => existsSync(path));
}

/** The helper this process would exec; absent on platforms whose prebuild ships none, such as Linux. */
export function activeSpawnHelperPath(): string | undefined {
  const dir = prebuildsDir();
  if (dir === undefined) return undefined;
  const path = join(dir, `${process.platform}-${process.arch}`, "spawn-helper");
  return existsSync(path) ? path : undefined;
}

/** Returns whether the file had to be repaired. Throws when it is still not executable afterwards. */
export function ensureExecutable(path: string): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    throw new Error(`cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((mode & EXECUTABLE_BITS) !== 0) return false;
  try {
    chmodSync(path, 0o755);
  } catch (error) {
    throw new Error(
      `${path} is not executable and could not be repaired (${error instanceof Error ? error.message : String(error)}); run: chmod +x ${path}`,
    );
  }
  return true;
}
