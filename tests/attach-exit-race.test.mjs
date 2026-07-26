
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@pty-server/protocol";

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

const { createAttachUpgradeHandler } = await import("../src/server/ws/attach.ts");

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function fakeSession() {
  const dataCallbacks = new Set();
  const exitCallbacks = new Set();
  let releaseSnapshot;
  const gate = new Promise((resolve) => { releaseSnapshot = resolve; });
  let sequence = 0;
  let exited;

  return {
    id: SESSION_ID,
    followSize: false,
    get currentSeq() { return sequence; },
    onData(callback) { dataCallbacks.add(callback); return () => dataCallbacks.delete(callback); },
    onExit(callback) { exitCallbacks.add(callback); return () => exitCallbacks.delete(callback); },
    async snapshot() { await gate; return "SNAPSHOT"; },
    toJSON() { return { id: SESSION_ID, cols: 80, rows: 24, ...(exited === undefined ? {} : { exited }) }; },
    write() {}, resize() {}, kill() {},

    releaseSnapshot,
    emit(chunk) { const seq = ++sequence; for (const callback of dataCallbacks) callback(chunk, seq); },
    exit(code) {
      exited = { code, at: Date.now() };
      for (const callback of exitCallbacks) callback(exited);
    },
  };
}

async function attach(session) {
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", createAttachUpgradeHandler({
    get: (id) => (id === session.id ? session : undefined),
    markAttached: () => {},
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/sessions/${session.id}/attach?cols=80&rows=24`);
  const frames = [];
  ws.on("message", (data, isBinary) => frames.push(isBinary ? data.toString("utf8") : JSON.parse(data.toString())));
  const closed = new Promise((resolve) => ws.on("close", resolve));
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });

  return { frames, closed, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a session that exits during the snapshot barrier still gets a full handshake", async () => {
  const session = fakeSession();
  const { frames, closed, close } = await attach(session);

  session.emit("post-marker output");
  session.exit(5);
  session.releaseSnapshot();

  await closed;
  await close();

  assert.deepEqual(frames[0], { t: "ready", protocol: PROTOCOL_VERSION, sessionId: SESSION_ID, cols: 80, rows: 24 });
  assert.equal(frames[1], "SNAPSHOT");
  assert.equal(frames[2], "post-marker output");
  assert.deepEqual(frames[3], { t: "exit", code: 5 });
  assert.equal(frames.length, 4);
});

test("a session that exits after the snapshot barrier still sends exit exactly once", async () => {
  const session = fakeSession();
  const { frames, closed, close } = await attach(session);

  session.releaseSnapshot();
  while (frames.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  session.exit(0);

  await closed;
  await close();

  assert.deepEqual(frames[0], { t: "ready", protocol: PROTOCOL_VERSION, sessionId: SESSION_ID, cols: 80, rows: 24 });
  assert.equal(frames[1], "SNAPSHOT");
  assert.deepEqual(frames[2], { t: "exit", code: 0 });
  assert.equal(frames.length, 3);
});

test("a client attaching after the session already exited gets the final screen and exit", async () => {
  const session = fakeSession();
  session.exit(3);
  const { frames, closed, close } = await attach(session);

  session.releaseSnapshot();

  await closed;
  await close();

  assert.deepEqual(frames[0], { t: "ready", protocol: PROTOCOL_VERSION, sessionId: SESSION_ID, cols: 80, rows: 24 });
  assert.equal(frames[1], "SNAPSHOT");
  assert.deepEqual(frames[2], { t: "exit", code: 3 });
  assert.equal(frames.length, 3);
});
