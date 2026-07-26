
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, runCli as runPtysCli, startPtysProcess, waitFor, waitForListening } from "./helpers.mjs";

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

function runDir(home) {
  return join(home, ".ptys", "run");
}

function socketPath(home) {
  return join(runDir(home), "default.sock");
}

function startServer(t, args = [], { home = isolatedHome(), port = pickPort() } = {}) {
  const handle = startPtysProcess(t, cliPath, ["server", "--listen", `127.0.0.1:${port}`, ...args], { home });
  return Object.assign(handle, { home, port });
}

async function startedServer(t, args = [], options = {}) {
  const handle = startServer(t, args, options);
  await waitForListening(handle);
  await waitFor(() => (existsSync(socketPath(handle.home)) ? true : undefined));
  return handle;
}

function runCli(args, home, env = {}) {
  return runPtysCli(cliPath, args, { home, env });
}

async function squatter(t, port) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests };
}

test("the CLI never sends a persisted token to a loopback TCP listener", async (t) => {
  const home = isolatedHome();
  mkdirSync(join(home, ".ptys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".ptys", "token"), "victim-token-must-not-leak", { mode: 0o600 });

  const port = pickPort();
  const listener = await squatter(t, port);
  const result = await runCli(["list", "--server", `127.0.0.1:${port}`], home);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(listener.requests.length > 0, "the squatter received no request at all");
  for (const request of listener.requests) {
    assert.equal(request.authorization, undefined, `token disclosed on ${request.url}`);
  }
});

test("the same applies to the attach WebSocket handshake", async (t) => {
  const home = isolatedHome();
  mkdirSync(join(home, ".ptys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".ptys", "token"), "victim-token-must-not-leak", { mode: 0o600 });

  const port = pickPort();
  const listener = await squatter(t, port);
  await runCli(["attach", "deadbeef", "--server", `127.0.0.1:${port}`], home);

  assert.ok(listener.requests.length > 0, "the squatter received no request at all");
  for (const request of listener.requests) {
    assert.equal(request.authorization, undefined, `token disclosed on ${request.url}`);
  }
});

test("a local client reaches a token-protected server with no credential at all", async (t) => {
  const handle = await startedServer(t, ["--token", "never-shared-with-the-cli"]);
  assert.ok(!existsSync(join(handle.home, ".ptys", "token")));

  const result = await runCli(["list"], handle.home);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ID\s+NAME\s+COMMAND/);
});

test("the same server still refuses an unauthenticated TCP request", async (t) => {
  const handle = await startedServer(t, ["--token", "never-shared-with-the-cli"]);
  const result = await runCli(["list", "--server", `127.0.0.1:${handle.port}`], handle.home, { PTYS_TOKEN: "wrong" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unauthorized/);
});

test("the control socket and its directory are private to this user", async (t) => {
  const handle = await startedServer(t);
  const stats = statSync(socketPath(handle.home));
  const directory = statSync(runDir(handle.home));

  assert.equal(stats.mode & 0o777, 0o600, "socket is not 0600");
  assert.equal(directory.mode & 0o077, 0, "run directory is reachable by other users");
});

test("a session created and attached over the control socket runs to completion", async (t) => {
  const handle = await startedServer(t);
  const result = await runCli(
    ["run", "--", "sh", "-c", "exit 6"],
    handle.home,
  );
  assert.equal(result.code, 6, result.stderr);
});

test("shutdown removes the socket, and a crashed server's socket does not block a restart", async (t) => {
  const first = await startedServer(t);
  const path = socketPath(first.home);

  first.proc.kill("SIGKILL");
  await new Promise((resolve) => first.proc.on("close", resolve));
  assert.ok(existsSync(path), "a SIGKILLed server should leave its socket behind");

  const second = await startedServer(t, [], { home: first.home, port: first.port });
  const result = await runCli(["list"], second.home);
  assert.equal(result.code, 0, result.stderr);

  second.proc.kill("SIGTERM");
  await new Promise((resolve) => second.proc.on("close", resolve));
  assert.ok(!existsSync(path), "a cleanly stopped server should remove its socket");
  assert.deepEqual(readdirSync(runDir(second.home)).filter((name) => name.endsWith(".sock")), []);
});

async function socketImpostor(t, socketPath) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { requests };
}

function runtimeDirWithSocketDir(mode) {
  const base = mkdtempSync(join(tmpdir(), "ptys-fallback-"));
  const directory = join(base, "ptys");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, mode);
  return { base, directory };
}

test("a client refuses a fallback control socket in a directory other users can reach", async (t) => {
  const { base, directory } = runtimeDirWithSocketDir(0o777);
  const impostor = await socketImpostor(t, join(directory, "default.sock"));

  const result = await runCli(["list"], isolatedHome(), { XDG_RUNTIME_DIR: base });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /no ptys server for instance default/);
  assert.match(result.stderr, /ignored .*default\.sock/);
  assert.deepEqual(impostor.requests, [], "the CLI sent commands to a socket in a world-writable directory");
});

test("a client refuses a control socket reached through a symlinked directory", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "ptys-fallback-"));
  const real = mkdtempSync(join(tmpdir(), "ptys-attacker-"));
  symlinkSync(real, join(base, "ptys"));
  const impostor = await socketImpostor(t, join(real, "default.sock"));

  const result = await runCli(["list"], isolatedHome(), { XDG_RUNTIME_DIR: base });

  assert.equal(result.code, 1);
  assert.deepEqual(impostor.requests, [], "the CLI followed a symlinked control socket directory");
});

test("a client still uses a fallback control socket in a private directory it owns", async (t) => {
  const { base, directory } = runtimeDirWithSocketDir(0o700);
  const impostor = await socketImpostor(t, join(directory, "default.sock"));

  const result = await runCli(["list"], isolatedHome(), { XDG_RUNTIME_DIR: base });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(impostor.requests.length > 0, "the fallback socket received no request");
});

test("concurrent daemon starts leave one owner and one pidfile", async (t) => {
  const home = isolatedHome();
  t.after(() => runCli(["server", "stop"], home));

  const attempts = await Promise.all(Array.from({ length: 3 }, () => runCli(["server", "start"], home)));
  const started = attempts.filter((attempt) => attempt.code === 0);
  assert.equal(started.length, 1, attempts.map((attempt) => attempt.stdout + attempt.stderr).join("\n"));

  const status = await runCli(["server", "status", "--json"], home);
  const daemons = JSON.parse(status.stdout);
  assert.equal(daemons.length, 1, status.stdout);
  assert.equal(daemons[0].alive, true, "the surviving daemon lost its pidfile");
  assert.match(started[0].stdout, new RegExp(`pid ${daemons[0].pid}\\b`));

  const list = await runCli(["list"], home);
  assert.equal(list.code, 0, list.stderr);
});
