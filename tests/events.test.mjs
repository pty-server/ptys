import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { isolatedHome, pickPort, spawnPtys, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");
let serverProc;
let baseUrl;
let workspaceId;
let home;

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
}

function postEvent(endpoint, body) {
  const unixPrefix = "http+unix:";
  const options = { method: "POST", headers: { "content-type": "application/json" } };
  if (endpoint.startsWith(unixPrefix)) {
    const rest = endpoint.slice(unixPrefix.length);
    const separator = rest.lastIndexOf(":/");
    options.socketPath = rest.slice(0, separator);
    options.path = rest.slice(separator + 1);
  } else {
    const url = new URL(endpoint);
    options.hostname = url.hostname;
    options.port = url.port;
    options.path = `${url.pathname}${url.search}`;
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        json: () => Promise.resolve(text.length === 0 ? undefined : JSON.parse(text)),
      }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function connectEvents(onEvent) {
  const url = new URL("/v1/events", baseUrl);
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString());
    if (message.t === "event") onEvent(message, ws);
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function createSessionWithEndpoint(command = ["sh", ["-c", "sleep 5"]]) {
  const endpointFile = join(mkdtempSync(join(tmpdir(), "ptys-event-endpoint-")), "endpoint");
  const [cmd, args] = command;
  const session = await api("/v1/sessions", {
    method: "POST",
    body: {
      workspaceId,
      cmd,
      args: ["-c", `printf '%s' "$PTYS_EVENT_ENDPOINT" > '${endpointFile}'; ${args[1] ?? "sleep 5"}`],
      env: {},
      cols: 80,
      rows: 24,
    },
  });
  assert.equal(session.status, 200);
  const endpoint = await waitFor(() => existsSync(endpointFile) ? readFileSync(endpointFile, "utf8") : undefined);
  return { session: session.body, endpoint };
}

before(async () => {
  const port = pickPort();
  home = isolatedHome("ptys-events-home-");
  serverProc = spawnPtys(cliPath, ["server", "--no-auth", "--listen", `127.0.0.1:${port}`], { home });
  let stdout = "";
  serverProc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  await waitFor(() => stdout.includes("listening") ? true : undefined);
  baseUrl = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), "ptys-events-workspace-"));
  const workspace = await api("/v1/workspaces", { method: "POST", body: { path: root } });
  workspaceId = workspace.body.id;
});

after(() => serverProc?.kill());

test("session event endpoint broadcasts custom events and request replies", async () => {
  const seen = [];
  const listener = await connectEvents((message, ws) => {
    seen.push(message);
    if (message.requestId !== undefined) {
      ws.send(JSON.stringify({
        t: "event.reply",
        requestId: message.requestId,
        event: { type: "answer", data: { ok: true } },
      }));
    }
  });
  const { session, endpoint } = await createSessionWithEndpoint();

  const notification = await postEvent(endpoint, { type: "notification", data: { message: "done" } });
  assert.equal(notification.status, 202);
  const notificationEvent = await waitFor(() => seen.find((message) => message.event.type === "notification"));
  assert.deepEqual(notificationEvent.event, { sessionId: session.id, type: "notification", data: { message: "done" } });
  assert.equal(notificationEvent.requestId, undefined);
  assert.equal(notificationEvent.ttl, undefined);

  const request = await postEvent(endpoint, { type: "confirmation", data: { ask: "ok?" }, request: true, timeoutSeconds: 1 });
  assert.equal(request.status, 200);
  assert.deepEqual((await request.json()).event, { type: "answer", data: { ok: true } });
  assert.equal(seen.find((message) => message.event.type === "confirmation").ttl, 1);

  const command = spawnPtys(cliPath, ["event", "--request", '{"type":"cli.answer","data":{}}'], {
    home,
    env: { PTYS_EVENT_ENDPOINT: endpoint },
  });
  let output = "";
  command.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    command.once("error", reject);
    command.once("close", resolve);
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output), { ok: true });
  listener.close();
});

test("request events use the default TTL and preserve event-reply behavior", async () => {
  let requestEvent;
  const listener = await connectEvents((message, ws) => {
    if (message.event.type !== "default-timeout") return;
    requestEvent = message;
    ws.send(JSON.stringify({
      t: "event.reply",
      requestId: message.requestId,
      event: { type: "answer", data: "received" },
    }));
  });
  const { endpoint } = await createSessionWithEndpoint();

  const response = await postEvent(endpoint, { type: "default-timeout", data: {}, request: true });
  assert.equal(response.status, 200);
  assert.equal(requestEvent.ttl, 30);
  assert.equal(typeof requestEvent.requestId, "string");
  assert.deepEqual((await response.json()).event, { type: "answer", data: "received" });
  listener.close();
});

test("request events fail without subscribers and timeout zero waits for a reply", async () => {
  const { endpoint } = await createSessionWithEndpoint();
  const noListener = await postEvent(endpoint, { type: "question", data: {}, request: true, timeoutSeconds: 1 });
  assert.equal(noListener.status, 409);

  const listener = await connectEvents((message, ws) => {
    if (message.requestId === undefined) return;
    assert.equal(message.ttl, 0);
    setTimeout(() => ws.send(JSON.stringify({
      t: "event.reply",
      requestId: message.requestId,
      event: { type: "answer", data: "later" },
    })), 100);
  });
  const started = Date.now();
  const response = await postEvent(endpoint, { type: "question", data: {}, request: true, timeoutSeconds: 0 });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started >= 80);
  assert.equal((await response.json()).event.data, "later");
  listener.close();
});

test("internal create, title, update, and exit events are global and live only", async () => {
  const seen = [];
  const listener = await connectEvents((message) => seen.push(message));
  const titled = await api("/v1/sessions", {
    method: "POST",
    body: { workspaceId, cmd: "sh", args: ["-c", "printf '\\033]2;build-title\\007'; sleep 2"], env: {}, cols: 80, rows: 24 },
  });
  assert.equal(titled.status, 200);
  await waitFor(() => seen.find((message) => message.event.type === "session.created" && message.event.sessionId === titled.body.id));
  const createdEvent = seen.find((message) => message.event.type === "session.created" && message.event.sessionId === titled.body.id).event;
  assert.equal(createdEvent.data.id, titled.body.id);
  assert.equal(createdEvent.data.name, "sh");
  await waitFor(() => seen.find((message) => message.event.type === "session.title"));
  assert.deepEqual(seen.find((message) => message.event.type === "session.title").event.data, { title: "build-title" });

  const renamed = await api(`/v1/sessions/${titled.body.id}`, { method: "PATCH", body: { name: "builder" } });
  assert.equal(renamed.status, 200);
  await waitFor(() => seen.find((message) => message.event.type === "session.updated"));
  assert.deepEqual(seen.find((message) => message.event.type === "session.updated").event, {
    sessionId: titled.body.id,
    type: "session.updated",
    data: { name: "builder" },
  });

  const exited = await api("/v1/sessions", {
    method: "POST",
    body: { workspaceId, cmd: "sh", args: ["-c", "exit 7"], env: {}, cols: 80, rows: 24 },
  });
  assert.equal(exited.status, 200);
  await waitFor(() => seen.find((message) => message.event.type === "session.exited" && message.event.sessionId === exited.body.id));
  const exitEvent = seen.find((message) => message.event.type === "session.exited" && message.event.sessionId === exited.body.id).event;
  assert.equal(exitEvent.data.code, 7);
  assert.equal(typeof exitEvent.data.at, "number");
  listener.close();
});

test("ptys event and event-listener use the session endpoint and global stream", async () => {
  const listener = spawnPtys(cliPath, ["event-listener"], { home });
  let stdout = "";
  listener.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const emitted = await api("/v1/sessions", {
    method: "POST",
    body: {
      workspaceId,
      cmd: process.execPath,
      args: [cliPath, "event", '{"type":"cli.notification","data":{"value":1}}'],
      env: {},
      cols: 80,
      rows: 24,
    },
  });
  assert.equal(emitted.status, 200);
  const event = await waitFor(() => stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((value) => value.type === "cli.notification"));
  assert.deepEqual(event.type, "cli.notification");
  listener.kill();
});
