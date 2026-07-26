
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@pty-server/protocol";
import { isolatedHome, ptysEnvironment } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

async function stubServer(onAttach) {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/v1/sessions")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: SESSION_ID, name: "stub" }]));
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => onAttach(ws));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendReady(ws) {
  ws.send(JSON.stringify({ t: "ready", protocol: PROTOCOL_VERSION, sessionId: SESSION_ID, cols: 80, rows: 24, seq: 0 }));
}

function runAttach(port, extraArgs = []) {
  const home = isolatedHome("ptys-attach-home-");
  const proc = spawn(process.execPath, [cliPath, "attach", SESSION_ID, "--server", `127.0.0.1:${port}`, ...extraArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    env: ptysEnvironment(home, { PTYS_TOKEN: "stub-token" }),
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk));
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) => proc.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { proc, done };
}

test("an incompatible protocol version is refused before any terminal traffic", async (t) => {
  const server = await stubServer((ws) => {
    ws.send(JSON.stringify({ t: "ready", protocol: PROTOCOL_VERSION + 1, sessionId: SESSION_ID, cols: 80, rows: 24 }));
    ws.send(Buffer.from("must never reach the terminal"));
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runAttach(server.port).done;
  assert.notEqual(code, 0);
  assert.match(stderr, new RegExp(`server speaks protocol ${PROTOCOL_VERSION + 1}, this CLI speaks ${PROTOCOL_VERSION}`));
  assert.match(stderr, /upgrade ptys/);
  assert.equal(stdout, "", "no output may reach the terminal across a version mismatch");
});

test("an older server protocol asks for a downgrade", async (t) => {
  const server = await stubServer((ws) => {
    ws.send(JSON.stringify({ t: "ready", protocol: PROTOCOL_VERSION - 1, sessionId: SESSION_ID, cols: 80, rows: 24 }));
  });
  t.after(() => server.close());

  const { code, stderr } = await runAttach(server.port).done;
  assert.notEqual(code, 0);
  assert.match(stderr, /downgrade ptys, or upgrade the server/);
});

test("terminal output before the handshake is refused", async (t) => {
  const server = await stubServer((ws) => {
    ws.send(Buffer.from("bytes with no handshake"));
  });
  t.after(() => server.close());

  const { code, stdout, stderr } = await runAttach(server.port).done;
  assert.notEqual(code, 0);
  assert.match(stderr, /before the protocol handshake/);
  assert.equal(stdout, "");
});

test("a clean but unexpected close fails instead of exiting 0", async (t) => {
  const server = await stubServer((ws) => {
    sendReady(ws);
    setTimeout(() => ws.close(), 50);
  });
  t.after(() => server.close());

  const { code, stderr } = await runAttach(server.port).done;
  assert.notEqual(code, 0, "a dropped attach must not look like success");
  assert.match(stderr, /closed unexpectedly/);
});

test("a server error frame fails with its reason", async (t) => {
  const server = await stubServer((ws) => {
    sendReady(ws);
    setTimeout(() => {
      ws.send(JSON.stringify({ t: "error", reason: "client too slow" }));
      ws.close();
    }, 50);
  });
  t.after(() => server.close());

  const { code, stderr } = await runAttach(server.port).done;
  assert.notEqual(code, 0);
  assert.match(stderr, /client too slow/);
});

test("a session exit propagates the program's exit code", async (t) => {
  const server = await stubServer((ws) => {
    sendReady(ws);
    setTimeout(() => {
      ws.send(JSON.stringify({ t: "exit", code: 3 }));
      ws.close();
    }, 50);
  });
  t.after(() => server.close());

  const { code } = await runAttach(server.port).done;
  assert.equal(code, 3);
});

test("SIGTERM restores the terminal and re-raises", async (t) => {
  const server = await stubServer((ws) => {
    sendReady(ws);
    ws.send(Buffer.from("hello"));
  });
  t.after(() => server.close());

  const attach = runAttach(server.port);
  await new Promise((resolve) => attach.proc.stdout.once("data", resolve));
  attach.proc.kill("SIGTERM");

  const { code, signal } = await attach.done;
  assert.equal(signal, "SIGTERM");
  assert.equal(code, null);
});

test("Ctrl-P Ctrl-Q detaches with exit code 0", async (t) => {
  const server = await stubServer((ws) => {
    sendReady(ws);
    ws.send(Buffer.from("hello"));
  });
  t.after(() => server.close());

  const attach = runAttach(server.port);
  await new Promise((resolve) => attach.proc.stdout.once("data", resolve));
  attach.proc.stdin.write(Buffer.from([0x10, 0x11]));

  const { code, stdout } = await attach.done;
  assert.equal(code, 0, "detach is an intentional end, not a failure");
  assert.match(stdout, /hello/);
});
