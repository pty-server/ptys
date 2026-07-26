import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import * as http from "node:http";
import { dirname } from "node:path";
import { isolatedHome, registerTypeScriptResolution } from "./helpers.mjs";

process.env.HOME = isolatedHome("ptys-ownership-home-");
delete process.env.PTYS_SOCKET_DIR;
delete process.env.XDG_RUNTIME_DIR;

registerTypeScriptResolution();

const { listenControlSocket, prepareControlSocketPath } = await import("../src/server/control-socket.ts");

function httpServer(t, body = "owner") {
  const server = http.createServer((_request, response) => response.end(body));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return server;
}

function get(socketPath) {
  return new Promise((resolve, reject) => {
    const call = http.request({ socketPath, path: "/", method: "GET", timeout: 1000 }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    });
    call.on("error", reject);
    call.end();
  });
}

test("an acquisition is refused while the pathname still answers", async (t) => {
  const path = prepareControlSocketPath("refused");
  const owner = await listenControlSocket(httpServer(t), path);

  const second = httpServer(t);
  await assert.rejects(listenControlSocket(second, path), /already listening on/);
  assert.equal(second.listening, false, "a refused acquisition left its staging socket bound");

  assert.equal(await get(path), "owner");
  owner.release();
  assert.ok(!existsSync(path));
});

test("concurrent acquisitions of one pathname elect exactly one owner", async (t) => {
  const path = prepareControlSocketPath("concurrent");
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => listenControlSocket(httpServer(t, "winner"), path)),
  );

  const owners = attempts.filter((attempt) => attempt.status === "fulfilled");
  assert.equal(owners.length, 1, `${owners.length} servers claimed the same pathname`);
  for (const rejected of attempts.filter((attempt) => attempt.status === "rejected")) {
    assert.match(rejected.reason.message, /already listening on|timed out waiting for the control socket lock/);
  }

  assert.equal(await get(path), "winner", "the elected owner does not answer on the pathname");
  owners[0].value.release();
  assert.ok(!existsSync(path));
  assert.deepEqual(readdirSync(dirname(path)), [], "acquisition left staging or lock files behind");
});

test("a shutting-down server neither unbinds nor removes its successor's socket", async (t) => {
  const path = prepareControlSocketPath("successor");
  const predecessorServer = httpServer(t, "predecessor");
  const predecessor = await listenControlSocket(predecessorServer, path);

  // A daemon stops answering before it releases the pathname, which is the window a successor starts in.
  await new Promise((resolve) => predecessorServer.close(() => resolve()));
  const successor = await listenControlSocket(httpServer(t, "successor"), path);
  const identity = lstatSync(path).ino;

  predecessor.release();

  assert.ok(existsSync(path), "the predecessor removed the successor's socket");
  assert.equal(lstatSync(path).ino, identity, "the pathname no longer names the successor's socket");
  assert.equal(await get(path), "successor");

  successor.release();
  assert.ok(!existsSync(path));
});
