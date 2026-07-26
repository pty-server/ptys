
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, runCli as runPtysCli, spawnPtys, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");
const packageVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;

const realHome = homedir();
const realTokenPath = join(realHome, ".ptys", "token");
const realTokenStatBefore = existsSync(realTokenPath) ? statSync(realTokenPath) : undefined;

function startServer(args, { home, host = "127.0.0.1" } = {}) {
  const port = pickPort();
  const fullArgs = ["server", "--listen", `${host}:${port}`, ...args];
  const proc = spawnPtys(cliPath, fullArgs, { home: home ?? isolatedHome("ptys-test-home-") });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://${host}:${port}`;

  return { proc, baseUrl, port, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitListening(handle, timeoutMs = 5000) {
  await waitFor(() => {
    if (handle.stdout.includes("listening")) return true;
    return undefined;
  }, timeoutMs);
}

function waitExit(proc) {
  return new Promise((resolve) => {
    proc.on("close", (code) => resolve(code));
  });
}

function runCli(args, { home } = {}) {
  return runPtysCli(cliPath, args, { home: home ?? isolatedHome("ptys-test-home-") });
}

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function apiFetch(baseUrl, path, { token, method, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: response.status, body: parsed };
}

function toWsUrl(baseUrl, sessionId, params = {}) {
  const url = new URL(`/v1/sessions/${sessionId}/attach`, baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("cols", "80");
  url.searchParams.set("rows", "24");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function tryAttach(baseUrl, sessionId, { token, origin, params, subprotocols } = {}) {
  return new Promise((resolve, reject) => {
    const url = toWsUrl(baseUrl, sessionId, params);
    const headers = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (origin !== undefined) headers.Origin = origin;
    const ws = subprotocols !== undefined
      ? new WebSocket(url, subprotocols, { headers })
      : new WebSocket(url, { headers });
    const messages = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("tryAttach: timed out"));
    }, 5000);

    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      res.resume();
      resolve({ ok: false, statusCode: res.statusCode, ws });
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
      }
    });
    ws.on("open", () => {
      waitFor(() => messages.find((m) => m.t === "ready"), 3000)
        .then((ready) => {
          clearTimeout(timer);
          resolve({ ok: true, ready, ws, messages, protocol: ws.protocol });
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
    ws.on("error", () => {
    });
  });
}

async function createSession(baseUrl, token, workspaceId, overrides = {}) {
  const { status, body } = await apiFetch(baseUrl, "/v1/sessions", {
    token,
    method: "POST",
    body: { workspaceId, cmd: "cat", args: [], env: {}, cols: 80, rows: 24, ...overrides },
  });
  assert.equal(status, 200, `session create failed: ${JSON.stringify(body)}`);
  return body;
}

test("auth required on HTTP: no token -> 401, correct token -> 200, missing on /v1/info too", async () => {
  const token = "test-token-1234567890";
  const handle = startServer(["--token", token]);
  await waitListening(handle);

  try {
    const unauthed = await apiFetch(handle.baseUrl, "/v1/sessions");
    assert.equal(unauthed.status, 401);
    assert.equal(unauthed.body.error, "unauthorized");

    const authed = await apiFetch(handle.baseUrl, "/v1/sessions", { token });
    assert.equal(authed.status, 200);

    const infoNoToken = await apiFetch(handle.baseUrl, "/v1/info");
    assert.equal(infoNoToken.status, 401);
    const infoAuthed = await apiFetch(handle.baseUrl, "/v1/info", { token });
    assert.equal(infoAuthed.status, 200);
    assert.equal(infoAuthed.body.version, packageVersion);
  } finally {
    handle.proc.kill();
  }
});

test("auth required on WS attach: no/bad token rejected, correct token attaches", async () => {
  const token = "test-token-abcdefghij";
  const handle = startServer(["--token", token]);
  await waitListening(handle);

  try {
    const workspace = await apiFetch(handle.baseUrl, "/v1/workspaces", {
      token,
      method: "POST",
      body: { path: mkdtempSync(join(tmpdir(), "ptys-test-ws-")) },
    });
    const session = await createSession(handle.baseUrl, token, workspace.body.id);

    const noToken = await tryAttach(handle.baseUrl, session.id, {});
    assert.equal(noToken.ok, false);
    assert.equal(noToken.statusCode, 401);

    const badToken = await tryAttach(handle.baseUrl, session.id, { token: "wrong" });
    assert.equal(badToken.ok, false);
    assert.equal(badToken.statusCode, 401);

    const good = await tryAttach(handle.baseUrl, session.id, { token });
    assert.equal(good.ok, true);
    assert.equal(good.ready.sessionId, session.id);
    good.ws.close();
  } finally {
    handle.proc.kill();
  }
});

test("timingSafeEqual digest compare handles length mismatch cleanly (no throw, clean 401)", async () => {
  const token = "short"; // deliberately a different length than the wrong guess below
  const handle = startServer(["--token", token]);
  await waitListening(handle);

  try {
    const wrongDifferentLength = await apiFetch(handle.baseUrl, "/v1/sessions", {
      token: "a-much-much-longer-wrong-token-than-the-real-one-1234567890",
    });
    assert.equal(wrongDifferentLength.status, 401);
    assert.equal(wrongDifferentLength.body.error, "unauthorized");

    const authed = await apiFetch(handle.baseUrl, "/v1/info", { token });
    assert.equal(authed.status, 200);
  } finally {
    handle.proc.kill();
  }
});

test("--no-auth + non-loopback host refuses to start; --no-auth + 127.0.0.1 starts fine", async () => {
  const port1 = pickPort();
  const badProc = spawnPtys(cliPath, ["server", "--listen", `0.0.0.0:${port1}`, "--no-auth"], {
    home: isolatedHome("ptys-test-home-"),
  });
  let badStderr = "";
  badProc.stderr.on("data", (chunk) => (badStderr += chunk.toString()));
  const code = await waitExit(badProc);
  assert.notEqual(code, 0, `expected non-zero exit, stderr: ${badStderr}`);
  assert.match(badStderr, /--no-auth/);

  const port2 = pickPort();
  const goodProc = spawnPtys(cliPath, ["server", "--listen", `127.0.0.1:${port2}`, "--no-auth"], {
    home: isolatedHome("ptys-test-home-"),
  });
  let goodStdout = "";
  goodProc.stdout.on("data", (chunk) => (goodStdout += chunk.toString()));
  await waitFor(() => (goodStdout.includes("listening") ? true : undefined), 5000);
  assert.match(goodStdout, /listening/);

  const res = await apiFetch(`http://127.0.0.1:${port2}`, "/v1/info");
  assert.equal(res.status, 200);

  goodProc.kill();
});

test("--no-auth rejects rebinding Host headers and non-JSON request bodies", async () => {
  const handle = startServer(["--no-auth"]);
  await waitListening(handle);

  try {
    const rebindingHost = await requestWithHost(`${handle.baseUrl}/v1/info`, `rebound.example:${handle.port}`);
    assert.equal(rebindingHost.status, 403);
    assert.deepEqual(rebindingHost.body, { error: "host not allowed" });

    const simpleRequest = await fetch(`${handle.baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ path: mkdtempSync(join(tmpdir(), "ptys-test-no-auth-")) }),
    });
    assert.equal(simpleRequest.status, 415);
    assert.deepEqual(await simpleRequest.json(), { error: "Content-Type must be application/json" });

    const jsonWithCharset = await fetch(`${handle.baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ path: mkdtempSync(join(tmpdir(), "ptys-test-no-auth-")) }),
    });
    assert.equal(jsonWithCharset.status, 200);
  } finally {
    handle.proc.kill();
  }
});

test("JSON request bodies larger than 64 KiB are rejected", async () => {
  const handle = startServer(["--no-auth"]);
  await waitListening(handle);

  try {
    const oversized = await fetch(`${handle.baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "x".repeat(64 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "JSON body exceeds 64 KiB" });

    const info = await apiFetch(handle.baseUrl, "/v1/info");
    assert.equal(info.status, 200);
  } finally {
    handle.proc.kill();
  }
});

test("transport policy precedes controllers and unclaimed paths use the shared fallback", async () => {
  const token = "dispatch-order-token";
  const origin = "https://console.example";
  const handle = startServer(["--token", token, "--allow-origin", origin]);
  await waitListening(handle);

  try {
    const preflight = await fetch(`${handle.baseUrl}/v1/workspaces`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

    const unauthorized = await fetch(`${handle.baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

    const invalidJson = await fetch(`${handle.baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: "invalid JSON body" });

    const unclaimed = await apiFetch(handle.baseUrl, "/v1/not-a-route", { token });
    assert.equal(unclaimed.status, 404);
    assert.deepEqual(unclaimed.body, { error: "not found" });
  } finally {
    handle.proc.kill();
  }
});

test("maxClosedSessions retains only the most recent exited sessions", async () => {
  const handle = startServer(["--no-auth", "--max-closed-sessions", "1"]);
  await waitListening(handle);

  try {
    const first = await createSession(handle.baseUrl, undefined, undefined, {
      cmd: process.execPath,
      args: ["-e", ""],
    });
    const second = await createSession(handle.baseUrl, undefined, undefined, {
      cmd: process.execPath,
      args: ["-e", ""],
    });
    for (const session of [first, second]) {
      const attached = await tryAttach(handle.baseUrl, session.id);
      attached.ws.close();
    }
    const retained = await waitFor(async () => {
      const sessions = await apiFetch(handle.baseUrl, "/v1/sessions");
      return sessions.body.length === 1 && sessions.body[0].id === second.id && sessions.body[0].exited !== undefined
        ? sessions.body
        : undefined;
    });
    assert.equal(retained[0].id, second.id);
    assert.notEqual(retained[0].id, first.id);
  } finally {
    handle.proc.kill();
  }
});

test("DELETE removes an exited session from retained history", async () => {
  const handle = startServer(["--no-auth"]);
  await waitListening(handle);

  try {
    const session = await createSession(handle.baseUrl, undefined, undefined, {
      cmd: process.execPath,
      args: ["-e", ""],
    });
    await waitFor(async () => {
      const response = await apiFetch(handle.baseUrl, `/v1/sessions/${session.id}`);
      return response.status === 200 && response.body.exited !== undefined ? true : undefined;
    });

    const deleted = await apiFetch(handle.baseUrl, `/v1/sessions/${session.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    const missing = await apiFetch(handle.baseUrl, `/v1/sessions/${session.id}`);
    assert.equal(missing.status, 404);
  } finally {
    handle.proc.kill();
  }
});

test("Origin check: absent Origin allowed, disallowed Origin rejected, allowed Origin via --allow-origin accepted", async () => {
  const token = "origin-test-token-xyz";
  const handle = startServer(["--token", token, "--allow-origin", "http://allowed.example"]);
  await waitListening(handle);

  try {
    const workspace = await apiFetch(handle.baseUrl, "/v1/workspaces", {
      token,
      method: "POST",
      body: { path: mkdtempSync(join(tmpdir(), "ptys-test-origin-")) },
    });
    const session = await createSession(handle.baseUrl, token, workspace.body.id);

    const noOrigin = await tryAttach(handle.baseUrl, session.id, { token });
    assert.equal(noOrigin.ok, true);
    noOrigin.ws.close();

    const disallowed = await tryAttach(handle.baseUrl, session.id, {
      token,
      origin: "http://evil.example",
    });
    assert.equal(disallowed.ok, false);
    assert.equal(disallowed.statusCode, 403);

    const allowed = await tryAttach(handle.baseUrl, session.id, {
      token,
      origin: "http://allowed.example",
    });
    assert.equal(allowed.ok, true);
    allowed.ws.close();
  } finally {
    handle.proc.kill();
  }
});

test("a local `ptys list` needs no credential, and the same call over TCP is refused", async () => {
  const home = isolatedHome();
  const handle = startServer([], { home });
  await waitListening(handle);

  try {
    const tokenPath = join(home, ".ptys", "token");
    await waitFor(() => (existsSync(tokenPath) ? true : undefined), 2000);
    const token = readFileSync(tokenPath, "utf8").trim();
    assert.ok(token.length > 0);

    const local = await runCli(["list"], { home });
    assert.equal(local.code, 0, `expected exit 0, stderr: ${local.stderr}`);

    const overTcp = await runCli(["list", "--server", handle.baseUrl.replace("http://", "")], { home });
    assert.notEqual(overTcp.code, 0);
    assert.match(overTcp.stderr, /unauthorized/);
  } finally {
    handle.proc.kill();
  }
});

test("WS auth via Sec-WebSocket-Protocol: valid ptys.bearer.<token> offer attaches and echoes the chosen subprotocol back", async () => {
  const token = "subproto-test-token-123";
  const handle = startServer(["--token", token]);
  await waitListening(handle);

  try {
    const workspace = await apiFetch(handle.baseUrl, "/v1/workspaces", {
      token,
      method: "POST",
      body: { path: mkdtempSync(join(tmpdir(), "ptys-test-subproto-")) },
    });
    const session = await createSession(handle.baseUrl, token, workspace.body.id);

    const result = await tryAttach(handle.baseUrl, session.id, {
      subprotocols: ["some.other.protocol", `ptys.bearer.${token}`],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ready.sessionId, session.id);
    assert.equal(result.protocol, `ptys.bearer.${token}`);
    result.ws.close();
  } finally {
    handle.proc.kill();
  }
});

test("WS auth via subprotocol is rejected: bad token, and a malformed empty-token offer", async () => {
  const token = "subproto-reject-token-456";
  const handle = startServer(["--token", token]);
  await waitListening(handle);

  try {
    const workspace = await apiFetch(handle.baseUrl, "/v1/workspaces", {
      token,
      method: "POST",
      body: { path: mkdtempSync(join(tmpdir(), "ptys-test-subproto-reject-")) },
    });
    const session = await createSession(handle.baseUrl, token, workspace.body.id);

    const badToken = await tryAttach(handle.baseUrl, session.id, {
      subprotocols: [`ptys.bearer.wrong-token`],
    });
    assert.equal(badToken.ok, false);
    assert.equal(badToken.statusCode, 401);

    const malformed = await tryAttach(handle.baseUrl, session.id, {
      subprotocols: ["ptys.bearer."],
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.statusCode, 401);

    const unrelated = await tryAttach(handle.baseUrl, session.id, {
      subprotocols: ["some.other.protocol"],
    });
    assert.equal(unrelated.ok, false);
    assert.equal(unrelated.statusCode, 401);

    const good = await tryAttach(handle.baseUrl, session.id, {
      subprotocols: [`ptys.bearer.${token}`],
    });
    assert.equal(good.ok, true);
    good.ws.close();
  } finally {
    handle.proc.kill();
  }
});

test("CORS: preflight OPTIONS from an allowed origin gets the allow headers; a non-allowlisted origin gets none", async () => {
  const token = "cors-test-token-789";
  const handle = startServer(["--token", token, "--allow-origin", "http://allowed.example"]);
  await waitListening(handle);

  try {
    const preflightAllowed = await fetch(`${handle.baseUrl}/v1/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://allowed.example",
        "access-control-request-method": "GET",
      },
    });
    assert.equal(preflightAllowed.headers.get("access-control-allow-origin"), "http://allowed.example");
    assert.match(preflightAllowed.headers.get("access-control-allow-methods") ?? "", /GET/);
    assert.equal(
      (preflightAllowed.headers.get("access-control-allow-headers") ?? "").toLowerCase(),
      "authorization, content-type",
    );

    const preflightDisallowed = await fetch(`${handle.baseUrl}/v1/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://evil.example",
        "access-control-request-method": "GET",
      },
    });
    assert.equal(preflightDisallowed.headers.get("access-control-allow-origin"), null);
    assert.equal(preflightDisallowed.headers.get("access-control-allow-methods"), null);
    assert.equal(preflightDisallowed.headers.get("access-control-allow-headers"), null);

    const realAllowed = await fetch(`${handle.baseUrl}/v1/info`, {
      headers: { origin: "http://allowed.example", authorization: `Bearer ${token}` },
    });
    assert.equal(realAllowed.status, 200);
    assert.equal(realAllowed.headers.get("access-control-allow-origin"), "http://allowed.example");
  } finally {
    handle.proc.kill();
  }
});

test("origins can be allowed and removed at runtime for CORS and WebSocket upgrades", async () => {
  const token = "dynamic-origin-token";
  const origin = "https://console.example";
  const handle = startServer(["--token", token]);
  await waitListening(handle);

  try {
    const session = await apiFetch(handle.baseUrl, "/v1/sessions", {
      token,
      method: "POST",
      body: { cmd: "sleep", args: ["10"], cols: 80, rows: 24 },
    });
    assert.equal(session.status, 200);

    const before = await tryAttach(handle.baseUrl, session.body.id, { token, origin });
    assert.equal(before.ok, false);
    assert.equal(before.statusCode, 403);

    const allowed = await apiFetch(handle.baseUrl, "/v1/config/origins", {
      token,
      method: "POST",
      body: { origin },
    });
    assert.equal(allowed.status, 201);
    assert.deepEqual(allowed.body.origins, [origin]);

    const cors = await fetch(`${handle.baseUrl}/v1/info`, {
      headers: { origin, authorization: `Bearer ${token}` },
    });
    assert.equal(cors.headers.get("access-control-allow-origin"), origin);

    const attached = await tryAttach(handle.baseUrl, session.body.id, { token, origin });
    assert.equal(attached.ok, true);
    attached.ws.close();

    const removed = await apiFetch(handle.baseUrl, `/v1/config/origins?origin=${encodeURIComponent(origin)}`, { token, method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.origins, []);

    const after = await tryAttach(handle.baseUrl, session.body.id, { token, origin });
    assert.equal(after.ok, false);
    assert.equal(after.statusCode, 403);

    const invalid = await apiFetch(handle.baseUrl, "/v1/config/origins", {
      token,
      method: "POST",
      body: { origin: "https://console.example/path" },
    });
    assert.equal(invalid.status, 400);
  } finally {
    handle.proc.kill();
  }
});

after(() => {
  const realTokenStatAfter = existsSync(realTokenPath) ? statSync(realTokenPath) : undefined;
  assert.equal(
    realTokenStatBefore === undefined,
    realTokenStatAfter === undefined,
    "real ~/.ptys/token existence changed during the test run",
  );
  if (realTokenStatBefore !== undefined && realTokenStatAfter !== undefined) {
    assert.equal(
      realTokenStatBefore.mtimeMs,
      realTokenStatAfter.mtimeMs,
      "real ~/.ptys/token was modified during the test run",
    );
  }
});
