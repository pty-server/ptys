import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, runCli as runPtysCli, spawnPtys, startPtysProcess, waitFor, waitForListening } from "./helpers.mjs";

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

function socketPath(home, instance = "default") { return join(home, ".ptys", "run", `${instance}.sock`); }
function tokenPath(home) { return join(home, ".ptys", "token"); }

function runCli(args, home, env = {}) {
  return runPtysCli(cliPath, args, { home, env });
}

function startServer(t, args = [], home = isolatedHome()) {
  const handle = startPtysProcess(t, cliPath, ["server", ...args], { home });
  return Object.assign(handle, { home });
}

async function startedServer(t, args = [], home = isolatedHome()) {
  const handle = startServer(t, args, home);
  await waitForListening(handle);
  return handle;
}

function connectable(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function apiStatus(port, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/info`, { headers });
  return response.status;
}

function statusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: "/v1/info", headers: { host } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("a server with no --listen binds nothing to the network and mints no token", async (t) => {
  const port = pickPort();
  const handle = await startedServer(t, []);

  assert.match(handle.stdout, /listening on unix:/);
  assert.doesNotMatch(handle.stdout, /listening on http:/);
  assert.equal(existsSync(socketPath(handle.home)), true, "the control socket is the whole server");
  assert.equal(existsSync(tokenPath(handle.home)), false, "nothing to authenticate, so no token exists");
  assert.equal(await connectable(port), false, "no TCP port answers");

  const list = await runCli(["list"], handle.home);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /ID\s+NAME\s+COMMAND/);
});

test("a session on a socket-only server can still emit events", async (t) => {
  const handle = await startedServer(t, []);

  const listener = spawnPtys(cliPath, ["event-listener"], { home: handle.home });
  t.after(() => listener.kill());
  let events = "";
  listener.stdout.on("data", (chunk) => (events += chunk.toString()));
  await new Promise((resolve) => setTimeout(resolve, 200));

  const emitted = await runCli(
    ["run", "--", process.execPath, cliPath, "event", '{"type":"socket.only","data":{"value":1}}'],
    handle.home,
  );
  assert.equal(emitted.code, 0, emitted.stderr);

  const event = await waitFor(() => events
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((value) => value.type === "socket.only"));
  assert.deepEqual(event.data, { value: 1 });
});

test("--listen binds an address, which is what brings the token into existence", async (t) => {
  const port = pickPort();
  const handle = await startedServer(t, ["--listen", `127.0.0.1:${port}`]);

  assert.match(handle.stdout, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  await waitFor(() => (existsSync(tokenPath(handle.home)) ? true : undefined));
  assert.equal(await apiStatus(port), 401, "an unauthenticated request is refused");

  const token = readFileSync(tokenPath(handle.home), "utf8").trim();
  assert.equal(await apiStatus(port, { authorization: `Bearer ${token}` }), 200);
});

test("several --listen addresses share one token and one control socket", async (t) => {
  const first = pickPort();
  const second = pickPort();
  const handle = await startedServer(t, ["--listen", `127.0.0.1:${first}`, "--listen", `127.0.0.1:${second}`]);

  await waitFor(() => (existsSync(tokenPath(handle.home)) ? true : undefined));
  const token = readFileSync(tokenPath(handle.home), "utf8").trim();
  assert.equal(await apiStatus(first, { authorization: `Bearer ${token}` }), 200);
  assert.equal(await apiStatus(second, { authorization: `Bearer ${token}` }), 200);
  assert.equal(existsSync(socketPath(handle.home)), true);
});

test("one unavailable address fails the whole start and leaves no socket behind", async (t) => {
  const taken = pickPort();
  const free = pickPort();
  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(taken, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));

  const home = isolatedHome();
  const result = await runCli(["server", "--listen", `127.0.0.1:${free}`, "--listen", `127.0.0.1:${taken}`], home);

  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`cannot listen on 127\\.0\\.0\\.1:${taken}`));
  assert.equal(existsSync(socketPath(home)), false, "a half-started server must leave no socket to find");
  assert.equal(await connectable(free), false, "nor a listener on the address that did bind");
});

test("a socket-only daemon records no addresses, and restart replays the ones it had", async (t) => {
  const home = isolatedHome();
  const pidfile = join(home, ".ptys", "run", "default.pid");
  t.after(async () => {
    await runCli(["server", "stop", "--all"], home);
  });

  const started = await runCli(["server", "start"], home);
  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual(JSON.parse(readFileSync(pidfile, "utf8")).running.listen, []);

  const status = await runCli(["server", "status", "--json"], home);
  assert.deepEqual(JSON.parse(status.stdout)[0].listen, []);
  assert.equal(existsSync(tokenPath(home)), false, "a daemon with no listener needs no token either");

  const stopped = await runCli(["server", "stop"], home);
  assert.equal(stopped.code, 0, stopped.stderr);

  const first = pickPort();
  const second = pickPort();
  const withAddresses = await runCli(
    ["server", "start", "--instance", "two", "--listen", `127.0.0.1:${first}`, "--listen", `127.0.0.1:${second}`],
    home,
  );
  assert.equal(withAddresses.code, 0, withAddresses.stderr);
  const restarted = await runCli(["server", "restart", "--instance", "two"], home);
  assert.equal(restarted.code, 0, restarted.stderr);

  const replayed = await runCli(["server", "status", "--instance", "two", "--json"], home);
  assert.deepEqual(JSON.parse(replayed.stdout)[0].listen, [`127.0.0.1:${first}`, `127.0.0.1:${second}`]);
  await waitFor(async () => (await connectable(second)) ? true : undefined);
});

test("--no-auth still refuses a non-loopback address, and accepts a Host naming any loopback one", async (t) => {
  const refused = await runCli(["server", "--no-auth", "--listen", `0.0.0.0:${pickPort()}`], isolatedHome());
  assert.notEqual(refused.code, 0, refused.stdout);
  assert.match(refused.stderr, /--no-auth requires a loopback host/);

  const first = pickPort();
  const second = pickPort();
  const handle = await startedServer(t, [
    "--no-auth",
    "--listen", `127.0.0.1:${first}`,
    "--listen", `localhost:${second}`,
  ]);

  for (const host of [`127.0.0.1:${first}`, `localhost:${second}`]) {
    assert.equal(await statusWithHost(first, host), 200, `Host ${host} should be accepted`);
  }
  assert.equal(await statusWithHost(first, "rebound.example"), 403);
  assert.equal(existsSync(tokenPath(handle.home)), false, "--no-auth means no token, listeners or not");
});
