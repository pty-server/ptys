import { request as httpRequest } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { isolatedHome, pickPort, registerTypeScriptResolution, startPtysProcess, waitFor, waitForListening } from "./helpers.mjs";

registerTypeScriptResolution();

const { sendRouteError } = await import("../src/server/routing/utils.ts");

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

test("an unexpected route failure answers 500 and leaves the cause in the log", () => {
  const response = { statuses: [], bodies: [], writeHead(status) { this.statuses.push(status); }, end(body) { this.bodies.push(body); } };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    sendRouteError(response, new Error("posix_spawnp failed."));
  } finally {
    console.error = original;
  }

  assert.deepEqual(response.statuses, [500]);
  assert.equal(JSON.parse(response.bodies[0]).error, "internal server error");
  // The 500 body is deliberately opaque, so a swallowed cause here is a cause nobody can ever recover.
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][1]), /posix_spawnp failed/);
});

function call(port, method, path, token) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: { authorization: `Bearer ${token}` },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("HTTP router decodes session parameters and keeps route matching exact", async (t) => {
  const port = pickPort();
  const token = "routing-test-token";
  const handle = startPtysProcess(t, cliPath, ["server", "--listen", `127.0.0.1:${port}`, "--token", token], {
    home: isolatedHome("ptys-routing-home-"),
  });
  await waitForListening(handle);

  const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd: "cat", args: [], env: {}, cols: 80, rows: 24 }),
  });
  assert.equal(created.status, 200);
  const session = await created.json();
  const encodedId = session.id.replace("-", "%2D");

  const decoded = await call(port, "GET", `/v1/sessions/${encodedId}`, token);
  assert.equal(decoded.status, 200);
  assert.equal(decoded.body.id, session.id);

  for (const [method, path] of [
    ["POST", "/v1/info"],
    ["GET", "/v1/Sessions"],
    ["GET", "/v1/sessions/"],
    ["GET", "/v1//sessions"],
    ["GET", "/v1/config/listeners"],
    ["GET", "/v1/sessions/%ZZ"],
  ]) {
    const response = await call(port, method, path, token);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(response.body, { error: "not found" });
  }
});

test("a listed session identifies its process, and stops claiming one once it exits", async (t) => {
  const port = pickPort();
  const token = "routing-introspection-token";
  const handle = startPtysProcess(t, cliPath, ["server", "--listen", `127.0.0.1:${port}`, "--token", token], {
    home: isolatedHome("ptys-routing-home-"),
  });
  await waitForListening(handle);

  const create = (body) => fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ env: {}, cols: 80, rows: 24, ...body }),
  }).then((response) => response.json());

  const running = await create({ cmd: "cat", args: [] });
  const exiting = await create({ cmd: "sh", args: ["-c", "exit 0"] });

  const listed = await waitFor(async () => {
    const sessions = (await call(port, "GET", "/v1/sessions", token)).body;
    const finished = sessions.find((session) => session.id === exiting.id);
    return finished?.exited === undefined ? undefined : sessions;
  });

  const live = listed.find((session) => session.id === running.id);
  assert.ok(Number.isInteger(live.pid) && live.pid > 0);
  assert.equal(live.cwd, realpathSync(process.cwd()));
  assert.equal(typeof live.process, "string");

  const finished = listed.find((session) => session.id === exiting.id);
  assert.ok(Number.isInteger(finished.pid) && finished.pid > 0, "pid stays meaningful as history");
  assert.equal(finished.cwd, realpathSync(process.cwd()));
  assert.equal(finished.process, undefined, "there is no foreground process once the session has exited");
});
