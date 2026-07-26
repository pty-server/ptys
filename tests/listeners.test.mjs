import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPort, isolatedHome, runCli as runPtysCli, waitFor } from "./helpers.mjs";

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

function tokenPath(home) { return join(home, ".ptys", "token"); }

function runCli(args, home, env = {}) {
  return runPtysCli(cliPath, args, { home, env });
}

function connectable(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const settle = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function call(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, method, path, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function startDaemon(t, home, args = []) {
  const started = await runCli(["server", "start", ...args], home);
  assert.equal(started.code, 0, started.stderr);
  t.after(() => runCli(["server", "stop", "--all"], home));
  return started;
}

test("adding the first listener opens the port and creates the token", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const port = await getPort();
  await startDaemon(t, home);
  assert.equal(existsSync(tokenPath(home)), false, "a socket-only daemon has no token yet");

  const added = await runCli(["config", "listen", "add", `127.0.0.1:${port}`], home);
  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));
  assert.match(added.stdout, /token: \S+/);

  const token = readFileSync(tokenPath(home), "utf8").trim();
  assert.match(added.stdout, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const authenticated = await call(port, "GET", "/v1/info", { authorization: `Bearer ${token}` });
  assert.equal(authenticated.status, 200);
  const anonymous = await call(port, "GET", "/v1/info");
  assert.equal(anonymous.status, 401, "the new listener authenticates like any other");

  const listed = await runCli(["config", "listen", "list", "--json"], home);
  assert.deepEqual(JSON.parse(listed.stdout), [{ host: "127.0.0.1", port }]);
  const status = await runCli(["server", "status", "--json"], home);
  assert.deepEqual(JSON.parse(status.stdout)[0].listen, [`127.0.0.1:${port}`]);
});

test("removing a listener closes the port while the control socket keeps working", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const port = await getPort();
  await startDaemon(t, home);
  await runCli(["config", "listen", "add", `127.0.0.1:${port}`], home);

  const removed = await runCli(["config", "listen", "remove", `127.0.0.1:${port}`], home);
  assert.equal(removed.code, 0, removed.stderr);
  await waitFor(async () => ((await connectable(port)) ? undefined : true));

  const list = await runCli(["list"], home);
  assert.equal(list.code, 0, list.stderr);
  const remaining = await runCli(["config", "listen", "list", "--json"], home);
  assert.deepEqual(JSON.parse(remaining.stdout), []);
});

test("the listener routes do not exist on a TCP listener", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const port = await getPort();
  await startDaemon(t, home, ["--listen", `127.0.0.1:${port}`]);
  const token = await waitFor(() => (existsSync(tokenPath(home)) ? readFileSync(tokenPath(home), "utf8").trim() : undefined));

  const overTcp = await call(port, "GET", "/v1/config/listeners", { authorization: `Bearer ${token}` });
  assert.equal(overTcp.status, 404);
  assert.deepEqual(JSON.parse(overTcp.body), { error: "not found" });

  const viaCli = await runCli(["config", "listen", "list", "--server", `127.0.0.1:${port}`], home, { PTYS_TOKEN: token });
  assert.notEqual(viaCli.code, 0);
  assert.match(viaCli.stderr, /unknown option '--server'/);
});

test("the listener commands neither advertise nor accept the remote options", async () => {
  const home = isolatedHome("ptys-listeners-home-");

  const help = await runCli(["config", "listen", "list", "--help"], home);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--instance/);
  assert.doesNotMatch(help.stdout, /--server|--token|--insecure/);

  const viaEnvironment = await runCli(["config", "listen", "list"], home, { PTYS_SERVER: "127.0.0.1:1" });
  assert.notEqual(viaEnvironment.code, 0);
  assert.match(viaEnvironment.stderr, /only accepted over the control socket/);
});

test("a duplicate or occupied address is refused and the daemon survives", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const port = await getPort();
  const occupied = await getPort();
  await startDaemon(t, home);

  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(occupied, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));

  const busy = await runCli(["config", "listen", "add", `127.0.0.1:${occupied}`], home);
  assert.notEqual(busy.code, 0, busy.stdout);
  assert.match(busy.stderr, /address already in use|cannot listen/);

  const first = await runCli(["config", "listen", "add", `127.0.0.1:${port}`], home);
  assert.equal(first.code, 0, first.stderr);
  const again = await runCli(["config", "listen", "add", `127.0.0.1:${port}`], home);
  assert.notEqual(again.code, 0, again.stdout);
  assert.match(again.stderr, /already listening/);

  const listed = await runCli(["config", "listen", "list", "--json"], home);
  assert.deepEqual(JSON.parse(listed.stdout), [{ host: "127.0.0.1", port }], "the failures changed nothing");
});

test("a listener cannot be closed by a request arriving on it", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const port = await getPort();
  await startDaemon(t, home);
  await runCli(["config", "listen", "add", `127.0.0.1:${port}`], home);
  const token = readFileSync(tokenPath(home), "utf8").trim();

  const refused = await call(port, "DELETE", `/v1/config/listeners?host=127.0.0.1&port=${port}`, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(refused.status, 404);
  assert.equal(await connectable(port), true, "the listener must still be there");

  const other = await getPort();
  await runCli(["config", "listen", "add", `127.0.0.1:${other}`], home);
  const removed = await runCli(["config", "listen", "remove", `127.0.0.1:${other}`], home);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(await connectable(port), true);
});

test("runtime listeners die with the daemon and are not replayed by restart", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const configured = await getPort();
  const runtime = await getPort();
  await startDaemon(t, home, ["--listen", `127.0.0.1:${configured}`]);
  await runCli(["config", "listen", "add", `127.0.0.1:${runtime}`], home);
  assert.equal(await connectable(runtime), true);

  const restarted = await runCli(["server", "restart"], home);
  assert.equal(restarted.code, 0, restarted.stderr);

  await waitFor(async () => ((await connectable(configured)) ? true : undefined));
  assert.equal(await connectable(runtime), false, "a runtime listener is not part of the configuration");
  const listed = await runCli(["config", "listen", "list", "--json"], home);
  assert.deepEqual(JSON.parse(listed.stdout), [{ host: "127.0.0.1", port: configured }]);
});

test("a --no-auth daemon still refuses a non-loopback address at runtime", async (t) => {
  const home = isolatedHome("ptys-listeners-home-");
  const port = await getPort();
  await startDaemon(t, home, ["--no-auth"]);

  const refused = await runCli(["config", "listen", "add", `0.0.0.0:${port}`], home);
  assert.notEqual(refused.code, 0, refused.stdout);
  assert.match(refused.stderr, /--no-auth requires a loopback host/);
  assert.equal(await connectable(port), false);

  const allowed = await runCli(["config", "listen", "add", `127.0.0.1:${port}`], home);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stdout, /token:/);
  assert.equal(existsSync(tokenPath(home)), false);
  assert.equal((await call(port, "GET", "/v1/info")).status, 200);
});
