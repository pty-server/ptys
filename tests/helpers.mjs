import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Lets an in-process test import a TypeScript source that resolves its own imports as built ".js" paths.
export function registerTypeScriptResolution() {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
        const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
}

let nextPort = 20_000 + (process.pid % 1_000) * 40;

export function pickPort() {
  return nextPort++;
}

export function isolatedHome(prefix = "ptys-test-home-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function ptysEnvironment(home, overrides = {}) {
  return {
    ...process.env,
    HOME: home,
    PTYS_TOKEN: undefined,
    PTYS_SERVER: undefined,
    PTYS_INSTANCE: undefined,
    PTYS_SOCKET_DIR: undefined,
    XDG_RUNTIME_DIR: undefined,
    ...overrides,
  };
}

export async function waitFor(predicate, timeoutMs = 5000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: timed out");
}

export async function reservePort(host = "127.0.0.1") {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a TCP port");
  }
  return {
    port: address.port,
    release: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}

export async function getPort(host = "127.0.0.1") {
  const reservation = await reservePort(host);
  await reservation.release();
  return reservation.port;
}

export function spawnPtys(cliPath, args, { home = isolatedHome(), env = {}, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  return spawn(process.execPath, [cliPath, ...args], { stdio, env: ptysEnvironment(home, env) });
}

export function captureProcess(t, proc) {
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  t.after(() => {
    if (!proc.killed) proc.kill("SIGKILL");
  });
  return { proc, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

export function startPtysProcess(t, cliPath, args, options = {}) {
  return captureProcess(t, spawnPtys(cliPath, args, options));
}

export function waitForListening(handle, timeoutMs = 5000) {
  return waitFor(() => (handle.stdout.includes("listening") ? handle : undefined), timeoutMs);
}

export function runCli(cliPath, args, { home = isolatedHome(), env = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawnPtys(cliPath, args, { home, env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
