import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect, createServer as createUnixServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, runCli as runPtysCli, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

function runCli(args, home) {
  return runPtysCli(cliPath, args, { home });
}

async function reachable(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/v1/info`)).status === 200; } catch { return false; }
}

function reachableSocket(path) {
  return new Promise((resolve) => {
    const socket = connect(path);
    const settle = (live) => { socket.destroy(); resolve(live); };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function cleanup(home) {
  const path = join(home, ".ptys", "run", "default.pid");
  try {
    if (existsSync(path)) process.kill(JSON.parse(readFileSync(path, "utf8")).pid, "SIGKILL");
  } catch {}
}

test("daemon starts, reports status, and stops", async () => {
  const home = isolatedHome();
  const port = pickPort();
  const pidfile = join(home, ".ptys", "run", "default.pid");
  try {
    const started = await runCli(["server", "start", "--no-auth", "--listen", `127.0.0.1:${port}`], home);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(existsSync(pidfile), true);
    await waitFor(() => reachable(port) ? true : undefined);

    const status = await runCli(["server", "status", "--json"], home);
    assert.equal(status.code, 0, status.stderr);
    const data = JSON.parse(status.stdout);
    assert.equal(data.length, 1);
    assert.equal(data[0].alive, true);

    const stopped = await runCli(["server", "stop"], home);
    assert.equal(stopped.code, 0, stopped.stderr);
    await waitFor(() => !existsSync(pidfile) ? true : undefined);
    await waitFor(async () => !(await reachable(port)) ? true : undefined);
    const after = await runCli(["server", "status", "--json"], home);
    assert.deepEqual(JSON.parse(after.stdout), []);
  } finally {
    await cleanup(home);
  }
});

test("second daemon launch of the same instance fails", async () => {
  const home = isolatedHome();
  const port = pickPort();
  try {
    const first = await runCli(["server", "start", "--no-auth", "--listen", `127.0.0.1:${port}`], home);
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(["server", "start", "--no-auth", "--listen", `127.0.0.1:${port}`], home);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /already running/);
  } finally {
    await cleanup(home);
  }
});

test("daemon browse roots survive restart", async () => {
  const home = isolatedHome();
  const root = mkdtempSync(join(tmpdir(), "ptys-daemon-browse-root-"));
  const port = pickPort();
  try {
    const started = await runCli(["server", "start", "--no-auth", "--listen", `127.0.0.1:${port}`, "--browse-root", root], home);
    assert.equal(started.code, 0, started.stderr);
    const before = await fetch(`http://127.0.0.1:${port}/v1/directories`).then((response) => response.json());
    assert.equal(before.entries[0].path, root);

    const restarted = await runCli(["server", "restart"], home);
    assert.equal(restarted.code, 0, restarted.stderr);
    await waitFor(() => reachable(port) ? true : undefined);
    const after = await fetch(`http://127.0.0.1:${port}/v1/directories`).then((response) => response.json());
    assert.equal(after.entries[0].path, root);
  } finally {
    await cleanup(home);
  }
});

test("~/.ptys.json supplies daemon defaults and CLI flags override them", async () => {
  const home = isolatedHome();
  const root = mkdtempSync(join(tmpdir(), "ptys-config-browse-root-"));
  const port = pickPort();
  const pidfile = join(home, ".ptys", "run", "default.pid");
  writeFileSync(join(home, ".ptys.json"), JSON.stringify({
    listen: [`127.0.0.1:${port}`],
    noAuth: true,
    browseRoots: [root],
    scrollback: 99,
    maxClosedSessions: 1,
  }));
  try {
    const started = await runCli(["server", "start", "--scrollback", "77"], home);
    assert.equal(started.code, 0, started.stderr);
    const running = JSON.parse(readFileSync(pidfile, "utf8")).running;
    assert.deepEqual(running, {
      listen: [{ host: "127.0.0.1", port }],
      noAuth: true,
      allowOrigins: [],
      browseRoots: [root],
      scrollback: 77,
      maxClosedSessions: 1,
    });
    const directories = await fetch(`http://127.0.0.1:${port}/v1/directories`).then((response) => response.json());
    assert.equal(directories.entries[0].path, root);

    const stopped = await runCli(["server", "stop"], home);
    assert.equal(stopped.code, 0, stopped.stderr);
  } finally {
    await cleanup(home);
  }
});

test("daemon restart preserves an explicit token in its mode-0600 pidfile", async () => {
  const home = isolatedHome();
  const port = pickPort();
  const token = "daemon-restart-custom-token";
  const pidfile = join(home, ".ptys", "run", "default.pid");
  try {
    const started = await runCli(["server", "start", "--listen", `127.0.0.1:${port}`, "--token", token], home);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(readFileSync(pidfile, "utf8")).running.token, token);
    assert.equal(statSync(pidfile).mode & 0o777, 0o600);

    const restarted = await runCli(["server", "restart"], home);
    assert.equal(restarted.code, 0, restarted.stderr);
    const response = await fetch(`http://127.0.0.1:${port}/v1/info`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await cleanup(home);
  }
});

test("a stale pidfile never signals the process that inherited its pid", async (t) => {
  const home = isolatedHome();
  const port = pickPort();
  const pidfile = join(home, ".ptys", "run", "default.pid");
  const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  await waitFor(() => foreign.pid !== undefined ? true : undefined);
  t.after(() => foreign.kill("SIGKILL"));

  const writeStalePidfile = () => {
    mkdirSync(join(home, ".ptys", "run"), { recursive: true, mode: 0o700 });
    writeFileSync(pidfile, JSON.stringify({
      pid: foreign.pid,
      instance: "default",
      startedAt: Date.now(),
      logPath: join(home, ".ptys", "run", "default.log"),
      running: { listen: [], noAuth: true, allowOrigins: [], scrollback: 5000, browseRoots: [], maxClosedSessions: 100 },
    }));
  };

  writeStalePidfile();
  const status = await runCli(["server", "status", "--json"], home);
  assert.equal(JSON.parse(status.stdout)[0].alive, false, "an unprovable pidfile must not read as alive");

  writeStalePidfile();
  const stopped = await runCli(["server", "stop"], home);
  assert.notEqual(stopped.code, 0, stopped.stdout);
  assert.match(stopped.stderr, /stale pidfile/);
  assert.equal(existsSync(pidfile), false, "the stale pidfile must be removed");
  assert.equal(foreign.killed, false);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0), "the foreign process must survive");
});

test("daemon launch fails loudly when a foreign process holds the port", async (t) => {
  const home = isolatedHome();
  const port = pickPort();
  const token = "daemon-probe-token-must-not-leak";
  const requests = [];
  const squatter = createServer((_request, response) => {
    requests.push(_request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ imposter: true }));
  });
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    await cleanup(home);
    await new Promise((resolve) => squatter.close(resolve));
  });

  const result = await runCli(["server", "start", "--listen", `127.0.0.1:${port}`, "--token", token], home);

  assert.notEqual(result.code, 0, `expected failure exit code, got ${result.code}. stdout: ${result.stdout}`);
  assert.doesNotMatch(result.stdout, /daemon started/, "must not report a started daemon when the port is taken");
  assert.match(result.stderr, /failed to start/i);
  assert.deepEqual(requests, [], "a port squatter must receive no HTTP request or bearer token");
  assert.ok(
    !existsSync(join(home, ".ptys", "run", "default.pid")),
    "must not leave a pidfile behind for a daemon that never started",
  );
});


function socketFor(home) {
  return join(home, ".ptys", "run", "default.sock");
}

test("a pid that does not answer on the control socket is never signalled", async (t) => {
  const home = isolatedHome();
  const port = pickPort();
  t.after(() => cleanup(home));

  const started = await runCli(["server", "start", "--listen", `127.0.0.1:${port}`], home);
  assert.match(started.stdout, /daemon started/, started.stderr);
  const pidfile = join(home, ".ptys", "run", "default.pid");
  const data = JSON.parse(readFileSync(pidfile, "utf8"));
  assert.equal(data.controlSocketPath, socketFor(home), "the pidfile must record the reported identity");
  t.after(() => { try { process.kill(data.pid, "SIGKILL"); } catch {} });

  const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  await waitFor(() => foreign.pid !== undefined ? true : undefined);
  t.after(() => foreign.kill("SIGKILL"));
  writeFileSync(pidfile, JSON.stringify({ ...data, pid: foreign.pid }));

  const status = await runCli(["server", "status", "--json"], home);
  assert.equal(JSON.parse(status.stdout)[0].alive, false, "a pid the socket does not claim must not read as alive");

  writeFileSync(pidfile, JSON.stringify({ ...data, pid: foreign.pid }));
  const stopped = await runCli(["server", "stop"], home);
  assert.notEqual(stopped.code, 0, stopped.stdout);
  assert.match(stopped.stderr, /stale pidfile/);
  assert.doesNotThrow(() => process.kill(foreign.pid, 0), "the foreign process must survive");

  assert.ok(await reachableSocket(socketFor(home)), "the running daemon must still be answering");
});

test("a SIGKILLed daemon reads as stale and its leftover socket refuses connections", async (t) => {
  const home = isolatedHome();
  const port = pickPort();
  t.after(() => cleanup(home));

  await runCli(["server", "start", "--listen", `127.0.0.1:${port}`], home);
  const pidfile = join(home, ".ptys", "run", "default.pid");
  const { pid } = JSON.parse(readFileSync(pidfile, "utf8"));

  process.kill(pid, "SIGKILL");
  await waitFor(async () => !existsSync(pidfile) || !(await reachableSocket(socketFor(home))) ? true : undefined);
  assert.ok(existsSync(socketFor(home)), "a killed daemon leaves its socket file behind");
  assert.equal(await reachableSocket(socketFor(home)), false, "the leftover socket must refuse connections");

  const status = await runCli(["server", "status", "--json"], home);
  assert.equal(JSON.parse(status.stdout)[0].alive, false);
});

test("a daemon that cannot take its control socket identity starts nothing at all", async (t) => {
  const home = isolatedHome();
  const port = pickPort();
  mkdirSync(join(home, ".ptys", "run"), { recursive: true, mode: 0o700 });
  const holder = createUnixServer();
  await new Promise((resolve) => holder.listen(socketFor(home), resolve));
  t.after(async () => {
    await cleanup(home);
    await new Promise((resolve) => holder.close(resolve));
  });

  const result = await runCli(["server", "start", "--listen", `127.0.0.1:${port}`], home);

  assert.notEqual(result.code, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /daemon started/, "readiness must not be reported without an identity");
  assert.match(result.stderr, /already listening/);
  assert.equal(await reachable(port), false, "a failed startup must leave no TCP listener behind");
  assert.ok(!existsSync(join(home, ".ptys", "run", "default.pid")));
});
