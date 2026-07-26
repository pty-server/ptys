
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, spawnPtys, waitFor } from "./helpers.mjs";
import {
  decideForward,
  decideCoalescingTick,
  BACKPRESSURE_THRESHOLDS,
} from "../src/server/ws/backpressure.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");


test("decideForward: live client under budget keeps sending", () => {
  const decision = decideForward("live", 0, false);
  assert.deepEqual(decision, { action: "send", nextState: "live" });
});

test("decideForward: non-eligible (plain read-write) client below the hard ceiling still sends, even above the 80% coalesce-enter mark", () => {
  const above80 = BACKPRESSURE_THRESHOLDS.coalesceEnter + 1;
  const decision = decideForward("live", above80, false);
  assert.deepEqual(decision, { action: "send", nextState: "live" });
});

test("decideForward: non-eligible client past the hard ceiling goes straight live -> dead (never through coalescing)", () => {
  const pastCeiling = BACKPRESSURE_THRESHOLDS.deadCeiling + 1;
  const decision = decideForward("live", pastCeiling, false);
  assert.deepEqual(decision, { action: "kill", nextState: "dead" });
});

test("decideForward: eligible client crossing the 80% coalesce-enter mark switches to coalescing (drop)", () => {
  const above80 = BACKPRESSURE_THRESHOLDS.coalesceEnter + 1;
  const decision = decideForward("live", above80, true);
  assert.deepEqual(decision, { action: "drop", nextState: "coalescing" });
});

test("decideForward: eligible client below 80% stays live and sends", () => {
  const below80 = BACKPRESSURE_THRESHOLDS.coalesceEnter - 1;
  const decision = decideForward("live", below80, true);
  assert.deepEqual(decision, { action: "send", nextState: "live" });
});

test("decideForward: eligible client already coalescing never gets raw chunks forwarded, regardless of buffer", () => {
  assert.deepEqual(decideForward("coalescing", 0, true), { action: "drop", nextState: "coalescing" });
  assert.deepEqual(
    decideForward("coalescing", BACKPRESSURE_THRESHOLDS.deadCeiling + 1, true),
    { action: "drop", nextState: "coalescing" },
  );
});

test("decideForward: a dead client is never resurrected by the forward path", () => {
  assert.deepEqual(decideForward("dead", 0, true), { action: "drop", nextState: "dead" });
  assert.deepEqual(decideForward("dead", 0, false), { action: "drop", nextState: "dead" });
});

test("decideCoalescingTick: hysteresis - stays coalescing (snapshot) between 50% and the hard ceiling", () => {
  const mid = (BACKPRESSURE_THRESHOLDS.coalesceExit + BACKPRESSURE_THRESHOLDS.deadCeiling) / 2;
  assert.equal(decideCoalescingTick(mid), "snapshot");
});

test("decideCoalescingTick: exits back to live once below the 50% exit threshold", () => {
  const below50 = BACKPRESSURE_THRESHOLDS.coalesceExit - 1;
  assert.equal(decideCoalescingTick(below50), "exit-to-live");
});

test("decideCoalescingTick: kills once the buffer keeps climbing past the hard ceiling while coalescing", () => {
  const pastCeiling = BACKPRESSURE_THRESHOLDS.deadCeiling + 1;
  assert.equal(decideCoalescingTick(pastCeiling), "kill");
});

test("thresholds: 80/50 hysteresis and 2x hard ceiling over an 8MB budget", () => {
  assert.equal(BACKPRESSURE_THRESHOLDS.budget, 8 * 1024 * 1024);
  assert.equal(BACKPRESSURE_THRESHOLDS.coalesceEnter, BACKPRESSURE_THRESHOLDS.budget * 0.8);
  assert.equal(BACKPRESSURE_THRESHOLDS.coalesceExit, BACKPRESSURE_THRESHOLDS.budget * 0.5);
  assert.equal(BACKPRESSURE_THRESHOLDS.deadCeiling, BACKPRESSURE_THRESHOLDS.budget * 2);
});


let serverProc;
let baseUrl;
let workspaceId;

async function startServer() {
  const port = pickPort();
  const host = "127.0.0.1";
  const home = isolatedHome("ptys-test-bp-home-");
  const proc = spawnPtys(cliPath, ["server", "--listen", `${host}:${port}`, "--no-auth"], { home });
  let stdout = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  await waitFor(() => (stdout.includes("listening") ? true : undefined), 5000);
  return { proc, baseUrl: `http://${host}:${port}` };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function toWsUrl(sessionId, params = {}) {
  const url = new URL(`/v1/sessions/${sessionId}/attach`, baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("cols", "80");
  url.searchParams.set("rows", "24");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

before(async () => {
  const started = await startServer();
  serverProc = started.proc;
  baseUrl = started.baseUrl;
  const cwd = isolatedHome("ptys-test-bp-");
  const workspace = await apiFetch("/v1/workspaces", { method: "POST", body: { path: cwd } });
  workspaceId = workspace.id;
});

after(() => {
  serverProc?.kill();
});


test(
  "best-effort: a coalesce-eligible (--lossy) read-write client survives the same flood without being kicked",
  { timeout: 15000 },
  async () => {
    const session = await apiFetch("/v1/sessions", {
      method: "POST",
      body: { workspaceId, cmd: "yes", args: [], env: {}, cols: 80, rows: 24 },
    });

    const ws = new WebSocket(toWsUrl(session.id, { lossy: 1 }));
    ws.binaryType = "nodebuffer";
    const messages = [];
    let closed = false;
    let errored = false;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString());
          messages.push(message);
          if (message.t === "error") errored = true;
        } catch {
        }
      }
    });
    ws.on("close", () => {
      closed = true;
    });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await waitFor(() => (messages.find((m) => m.t === "ready") ? true : undefined), 3000);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.equal(errored, false, "a lossy client should not receive {t:'error'} under a flood");
    assert.equal(closed, false, "a lossy client should stay connected under a flood");

    ws.close();
  },
);
