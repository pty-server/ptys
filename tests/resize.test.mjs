
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { isolatedHome, ptysEnvironment, reservePort, runCli as runPtysCli, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

let serverProc;
let baseUrl;
let workspaceId;

async function startServer() {
  const host = "127.0.0.1";
  const reservation = await reservePort(host);
  const port = reservation.port;
  const home = isolatedHome("ptys-resize-home-");
  await reservation.release();
  const proc = spawn(
    process.execPath,
    [cliPath, "server", "--listen", `${host}:${port}`, "--no-auth"],
    { stdio: ["ignore", "pipe", "pipe"], env: ptysEnvironment(home) },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await waitFor(() => (stdout.includes("listening") ? true : undefined), 5000);
  if (!stdout.includes("listening")) {
    throw new Error(`server did not start: ${stderr}`);
  }
  return { proc, baseUrl: `http://${host}:${port}` };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

async function createSession(overrides = {}) {
  return apiFetch("/v1/sessions", {
    method: "POST",
    body: {
      workspaceId,
      cmd: "cat",
      args: [],
      env: {},
      cols: 80,
      rows: 24,
      ...overrides,
    },
  });
}

function toWsUrl(sessionId, { cols, rows, readonly } = {}) {
  const url = new URL(`/v1/sessions/${sessionId}/attach`, baseUrl);
  url.protocol = "ws:";
  if (cols !== undefined) url.searchParams.set("cols", String(cols));
  if (rows !== undefined) url.searchParams.set("rows", String(rows));
  if (readonly) url.searchParams.set("readonly", "1");
  return url.toString();
}

async function attach(sessionId, opts = {}) {
  const ws = new WebSocket(toWsUrl(sessionId, opts));
  ws.binaryType = "nodebuffer";
  const messages = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const ready = await waitFor(() => messages.find((m) => m.t === "ready"), 5000);
  return { ws, messages, ready };
}

function waitForMessage(handle, predicate, timeoutMs = 3000) {
  return waitFor(() => handle.messages.find(predicate), timeoutMs);
}

function closeAndWait(ws) {
  return new Promise((resolve) => {
    ws.once("close", resolve);
    ws.close();
  });
}

before(async () => {
  const started = await startServer();
  serverProc = started.proc;
  baseUrl = started.baseUrl;
  const cwd = isolatedHome("ptys-test-");
  const workspace = await apiFetch("/v1/workspaces", { method: "POST", body: { path: cwd } });
  workspaceId = workspace.id;
});

after(() => {
  serverProc?.kill();
});

test("solo adopt: lone read-write client's size becomes the session size", async () => {
  const session = await createSession({ cols: 80, rows: 24 });
  const a = await attach(session.id, { cols: 120, rows: 40 });
  assert.equal(a.ready.cols, 120);
  assert.equal(a.ready.rows, 40);

  const fetched = await apiFetch(`/v1/sessions/${session.id}`);
  assert.equal(fetched.cols, 120);
  assert.equal(fetched.rows, 40);

  await closeAndWait(a.ws);
});

test("no collapse: a second, smaller read-write client letterboxes and does not reflow the first", async () => {
  const session = await createSession({ cols: 80, rows: 24 });
  const a = await attach(session.id, { cols: 120, rows: 40 });
  assert.equal(a.ready.cols, 120);
  assert.equal(a.ready.rows, 40);

  const beforeCount = a.messages.length;
  const b = await attach(session.id, { cols: 80, rows: 24 });
  assert.equal(b.ready.cols, 120);
  assert.equal(b.ready.rows, 40);

  const fetched = await apiFetch(`/v1/sessions/${session.id}`);
  assert.equal(fetched.cols, 120);
  assert.equal(fetched.rows, 40);

  await new Promise((resolve) => setTimeout(resolve, 200));
  const newMessages = a.messages.slice(beforeCount);
  assert.equal(
    newMessages.some((m) => m.t === "resized"),
    false,
    "attaching client A must not be reflowed by client B's attach",
  );

  await closeAndWait(a.ws);
  await closeAndWait(b.ws);
});

test("explicit resize is honored and broadcast to other attached clients", async () => {
  const session = await createSession({ cols: 80, rows: 24 });
  const a = await attach(session.id, { cols: 80, rows: 24 });
  const b = await attach(session.id, { cols: 200, rows: 60, readonly: true });
  assert.equal(b.ready.cols, 80);
  assert.equal(b.ready.rows, 24);

  a.ws.send(JSON.stringify({ t: "resize", cols: 100, rows: 30 }));

  const resized = await waitForMessage(b, (m) => m.t === "resized");
  assert.equal(resized.cols, 100);
  assert.equal(resized.rows, 30);

  const fetched = await apiFetch(`/v1/sessions/${session.id}`);
  assert.equal(fetched.cols, 100);
  assert.equal(fetched.rows, 30);

  await closeAndWait(a.ws);
  await closeAndWait(b.ws);
});

test("read-only attach never changes the session size", async () => {
  const session = await createSession({ cols: 80, rows: 24 });
  const viewer = await attach(session.id, { cols: 200, rows: 60, readonly: true });
  assert.equal(viewer.ready.cols, 80);
  assert.equal(viewer.ready.rows, 24);

  const fetched = await apiFetch(`/v1/sessions/${session.id}`);
  assert.equal(fetched.cols, 80);
  assert.equal(fetched.rows, 24);

  await closeAndWait(viewer.ws);
});

test("late attach to an exited session at a new size keeps the server alive", async () => {
  const session = await createSession({ cmd: "sh", args: ["-c", "exit 0"] });
  await waitFor(async () => {
    const fetched = await apiFetch(`/v1/sessions/${session.id}`);
    return fetched.exited !== undefined ? fetched : undefined;
  });

  const late = await attach(session.id, { cols: 120, rows: 40 });
  assert.equal(late.ready.cols, 120);
  assert.equal(late.ready.rows, 40);

  const info = await apiFetch("/v1/info");
  assert.equal(typeof info.serverId, "string");

  await waitForMessage(late, (message) => message.t === "exit");
});

test("--follow-size: session size is min(cols)/min(rows) across read-write clients, and grows back on detach", async () => {
  const session = await createSession({ cols: 80, rows: 24, followSize: true });

  const a = await attach(session.id, { cols: 120, rows: 40 });
  assert.equal(a.ready.cols, 120);
  assert.equal(a.ready.rows, 40);

  const b = await attach(session.id, { cols: 80, rows: 24 });
  const resizedForA = await waitForMessage(a, (m) => m.t === "resized");
  assert.equal(resizedForA.cols, 80);
  assert.equal(resizedForA.rows, 24);

  let fetched = await apiFetch(`/v1/sessions/${session.id}`);
  assert.equal(fetched.cols, 80);
  assert.equal(fetched.rows, 24);

  const beforeDetachCount = a.messages.length;
  await closeAndWait(b.ws);

  await waitFor(async () => {
    const dims = await apiFetch(`/v1/sessions/${session.id}`);
    return dims.cols === 120 && dims.rows === 40 ? dims : undefined;
  }, 3000);

  fetched = await apiFetch(`/v1/sessions/${session.id}`);
  assert.equal(fetched.cols, 120);
  assert.equal(fetched.rows, 40);

  const growBack = a.messages.slice(beforeDetachCount).find((m) => m.t === "resized");
  assert.ok(growBack, "A should have been notified the session grew back");
  assert.equal(growBack.cols, 120);
  assert.equal(growBack.rows, 40);

  await closeAndWait(a.ws);
});

test("--size WxH sets initial session dims via `ptys start`, and rejects a bad format", async () => {
  const cwd = isolatedHome("ptys-test-start-");

  const good = await runCli(["start", "--server", baseUrl, "--cwd", cwd, "--size", "120x40", "--", "cat"]);
  assert.equal(good.code, 0, `expected exit 0, got ${good.code}: ${good.stderr}`);
  const match = /started session (\S+)/.exec(good.stdout);
  assert.ok(match, `expected "started session <id>" in stdout, got: ${good.stdout}`);
  const fetched = await apiFetch(`/v1/sessions/${match[1]}`);
  assert.equal(fetched.cols, 120);
  assert.equal(fetched.rows, 40);

  const bad = await runCli(["start", "--server", baseUrl, "--cwd", cwd, "--size", "notasize", "--", "cat"]);
  assert.notEqual(bad.code, 0, "bad --size format should exit non-zero");
  assert.match(bad.stderr, /Invalid --size/);
});

function runCli(args) {
  return runPtysCli(cliPath, args);
}
