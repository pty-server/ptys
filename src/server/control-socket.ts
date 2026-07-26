import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync, type Stats } from "node:fs";
import type * as http from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { controlSocketCandidates, SOCKET_PATH_LIMIT } from "../paths.js";
import { closeHttpServer } from "./close-http-server.js";

export const CONTROL_SOCKET_SUPPORTED = process.platform !== "win32";

/** "/" plus a dot and eight hex characters: the staging name this process binds before publishing it. */
const STAGING_NAME_BYTES = 10;

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
/**
 * A lock is only ever held across one liveness probe and one rename, so anything this old was abandoned by a
 * process that died mid-acquisition. It stays well below LOCK_TIMEOUT_MS so such a lock is reclaimed within
 * the wait rather than surfacing as a startup failure, and a wrong judgement costs only a retry: the holder
 * verifies it still owns the pathname.
 */
const LOCK_STALE_MS = 2000;

/** An acquired control socket pathname, owned by this process until it is released. */
export interface ControlSocket {
  readonly path: string;
  release(): void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function currentUid(): number | undefined {
  return process.getuid?.();
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** A directory only this user can reach: a real directory, not a symlink, owned by us and 0700. */
export function isPrivateDirectory(directory: string): boolean {
  try {
    const stats = lstatSync(directory);
    return stats.isDirectory() && stats.uid === currentUid() && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether connecting to this pathname proves the peer runs as this user. Every candidate directory is
 * predictable, so a client must establish that before it treats a socket as an authenticated transport:
 * otherwise another user's socket in a shared fallback directory receives its commands and input.
 */
export function isTrustedControlSocket(path: string): boolean {
  if (!isPrivateDirectory(dirname(path))) {
    return false;
  }
  try {
    const stats = lstatSync(path);
    return stats.isSocket() && stats.uid === currentUid();
  } catch {
    return false;
  }
}

function fitsSocketPathLimit(candidate: string): boolean {
  return Buffer.byteLength(candidate) <= SOCKET_PATH_LIMIT &&
    Buffer.byteLength(dirname(candidate)) + STAGING_NAME_BYTES <= SOCKET_PATH_LIMIT;
}

export function prepareControlSocketPath(instance: string): string {
  const candidates = controlSocketCandidates(instance);
  for (const candidate of candidates) {
    if (!fitsSocketPathLimit(candidate)) {
      continue;
    }
    const directory = dirname(candidate);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!isPrivateDirectory(directory)) {
        // A directory we own but that others can reach is tightened; anything else belongs to someone else.
        const stats = lstatSync(directory);
        if (!stats.isDirectory() || stats.uid !== currentUid()) {
          continue;
        }
        chmodSync(directory, 0o700);
        if (!isPrivateDirectory(directory)) {
          continue;
        }
      }
    } catch {
      continue;
    }
    return candidate;
  }
  throw new Error(
    `no usable control socket path (tried ${candidates.join(", ")}); ` +
    "set PTYS_SOCKET_DIR to a private directory with a short path",
  );
}

function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const settle = (live: boolean): void => {
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

interface InstanceLock {
  release(): void;
}

function pathNamesDescriptor(path: string, fd: number): boolean {
  try {
    return sameFile(lstatSync(path), fstatSync(fd));
  } catch {
    return false;
  }
}

function createLockFile(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST")) return undefined;
    throw error;
  }
  writeSync(fd, `${process.pid}\n`);
  return fd;
}

function removeAbandonedLock(path: string): void {
  try {
    if (Date.now() - lstatSync(path).mtimeMs > LOCK_STALE_MS) {
      rmSync(path, { force: true });
    }
  } catch {
  }
}

/**
 * Serializes control socket acquisition for one pathname, so inspecting a stale socket, removing it and
 * binding a replacement cannot interleave with another start doing the same.
 */
async function acquireInstanceLock(socketPath: string): Promise<InstanceLock> {
  const path = `${socketPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const fd = createLockFile(path);
    if (fd !== undefined) {
      // A holder that judged this lock abandoned unlinks the pathname and creates its own, so holding the
      // descriptor is not ownership: the pathname must still name the file this process created.
      if (pathNamesDescriptor(path, fd)) {
        return {
          release: () => {
            if (pathNamesDescriptor(path, fd)) rmSync(path, { force: true });
            closeSync(fd);
          },
        };
      }
      closeSync(fd);
    } else {
      removeAbandonedLock(path);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the control socket lock ${path}`);
    }
    await delay(LOCK_RETRY_MS);
  }
}

function stagingPath(path: string): string {
  return join(dirname(path), `.${randomBytes(4).toString("hex")}`);
}

function listenOn(server: http.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Binds a private staging pathname, then publishes it under `path` with a rename while holding the
 * instance lock. Two properties depend on the staging step: acquisition never unlinks a pathname another
 * start may already have bound, and Node unlinks only the staging name when the server closes, so a
 * shutting-down server can never remove a successor's socket.
 */
export async function listenControlSocket(server: http.Server, path: string): Promise<ControlSocket> {
  const staging = stagingPath(path);
  await listenOn(server, staging);

  try {
    chmodSync(staging, 0o600);
    const lock = await acquireInstanceLock(path);
    try {
      if (await isSocketLive(path)) {
        throw new Error(`another ptys server is already listening on ${path}`);
      }
      renameSync(staging, path);
    } finally {
      lock.release();
    }
  } catch (error) {
    await closeHttpServer(server);
    rmSync(staging, { force: true });
    throw error;
  }

  const identity = lstatSync(path);
  return {
    path,
    release: () => {
      try {
        if (sameFile(lstatSync(path), identity)) rmSync(path, { force: true });
      } catch {
      }
    },
  };
}
