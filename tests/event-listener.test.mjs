
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { isolatedHome, pickPort, spawnPtys, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

function spawnCli(args, home) {
  const proc = spawnPtys(cliPath, args, { home });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk));
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) => proc.on("close", (code) => resolve(code)));
  return { proc, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test("event-listener exits nonzero when the server drops the stream", async () => {
  const home = isolatedHome();
  const port = pickPort();
  const server = spawnCli(["server", "--no-auth", "--listen", `127.0.0.1:${port}`], home);
  try {
    await waitFor(() => (server.stdout.includes("listening") ? true : undefined));
    const listener = spawnCli(["event-listener", "--server", `127.0.0.1:${port}`], home);

    await waitFor(async () => {
      await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "cat", args: [], env: {}, cols: 80, rows: 24 }),
      });
      return listener.stdout.includes("session.created") ? true : undefined;
    });

    server.proc.kill();
    const code = await listener.closed;
    assert.notEqual(code, 0, `expected a failure exit, got ${code}: ${listener.stderr}`);
    assert.match(listener.stderr, /event stream closed/);
  } finally {
    server.proc.kill();
    await server.closed;
    rmSync(home, { recursive: true, force: true });
  }
});

test("event-listener exits nonzero on a clean remote close", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (ws) => ws.close(1000, "shutting down"));

  const home = isolatedHome();
  try {
    const listener = spawnCli(["event-listener", "--server", `127.0.0.1:${wss.address().port}`], home);
    const code = await listener.closed;
    assert.notEqual(code, 0, `expected a failure exit, got ${code}: ${listener.stderr}`);
    assert.match(listener.stderr, /closed by the server \(code 1000\): shutting down/);
  } finally {
    wss.close();
    rmSync(home, { recursive: true, force: true });
  }
});
