import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, registerTypeScriptResolution, startPtysProcess, waitFor, waitForListening } from "./helpers.mjs";

registerTypeScriptResolution();

const { resolveLiveCwd } = await import("../src/server/proc-cwd.ts");

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

async function startServer(t, extraArgs = []) {
  const port = pickPort();
  const token = `exec-test-token-${port}`;
  const handle = startPtysProcess(t, cliPath, [
    "server",
    "--listen",
    `127.0.0.1:${port}`,
    "--token",
    token,
    ...extraArgs,
  ], { home: isolatedHome("ptys-exec-home-") });
  await waitForListening(handle);

  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  const createSession = async (request = {}) => {
    const created = await api("POST", "/v1/sessions", { cmd: "cat", args: [], env: {}, cols: 80, rows: 24, ...request });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body;
  };

  return { port, token, api, createSession };
}

test("exec runs a command in the session's workspace and reports the directory it used", async (t) => {
  const server = await startServer(t);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ptys-exec-workspace-")));
  const workspace = await server.api("POST", "/v1/workspaces", { path: directory });
  assert.equal(workspace.status, 200);
  const session = await server.createSession({ workspaceId: workspace.body.id });

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "pwd" });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, 0);
  assert.equal(result.body.stdout.trim(), directory);
  assert.equal(result.body.cwd, directory);
  assert.equal(result.body.truncated, false);
  assert.equal(result.body.timedOut, false);
  assert.ok(typeof result.body.durationMs === "number");
});

test("exec passes arguments straight through with no shell to expand them", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, {
    cmd: "echo",
    args: ["$HOME; rm -rf /"],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, 0);
  assert.equal(result.body.stdout.trim(), "$HOME; rm -rf /");
});

test("exec writes stdin and closes it, so a filter terminates on its own", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "cat", stdin: "from the client" });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, 0);
  assert.equal(result.body.stdout, "from the client");
});

test("exec inherits the session environment", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession({ env: { PTYS_EXEC_MARKER: "inherited" } });

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "printenv", args: ["PTYS_EXEC_MARKER"] });
  assert.equal(result.status, 200);
  assert.equal(result.body.stdout.trim(), "inherited");
});

test("a command that cannot be spawned is data, not a server error", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "ptys-no-such-binary-xyz" });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, null);
  assert.ok(result.body.stderr.length > 0, "the reason must survive to the client");
});

test("a non-zero exit is reported as its exit code", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "sh", args: ["-c", "exit 3"] });
  assert.equal(result.status, 200);
  assert.equal(result.body.code, 3);
});

test("exec stops a command at its timeout and still answers", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "sleep", args: ["30"], timeoutMs: 200 });
  assert.equal(result.status, 200);
  assert.equal(result.body.timedOut, true);
  assert.equal(result.body.code, null);
});

test("output past the cap is truncated rather than failed", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const result = await server.api("POST", `/v1/sessions/${session.id}/exec`, {
    cmd: "head",
    args: ["-c", "4000000", "/dev/zero"],
    timeoutMs: 20_000,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.truncated, true);
  assert.ok(result.body.stdout.length <= 1024 * 1024);
});

test("a session cannot hold more commands in flight than the cap allows, and frees them again", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ptys-exec-slots-")));
  const started = (index) => join(directory, String(index));

  const blockers = Array.from({ length: 4 }, (_, index) =>
    server.api("POST", `/v1/sessions/${session.id}/exec`, {
      cmd: "sh",
      args: ["-c", `touch ${started(index)} && sleep 2`],
      timeoutMs: 20_000,
    }));
  await waitFor(() => (blockers.every((_, index) => existsSync(started(index))) ? true : undefined));

  const refused = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "true" });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.body, { error: "too many concurrent commands for this session" });

  for (const blocker of await Promise.all(blockers)) assert.equal(blocker.status, 200);

  const afterwards = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "true" });
  assert.equal(afterwards.status, 200, "a finished command must release its slot");
});

test("a command that ignores SIGTERM is killed anyway, so exec always answers", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const startedAt = Date.now();
  const stubborn = await server.api("POST", `/v1/sessions/${session.id}/exec`, {
    cmd: "sh",
    args: ["-c", "trap '' TERM; sleep 30"],
    timeoutMs: 200,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(stubborn.status, 200);
  assert.equal(stubborn.body.timedOut, true);
  assert.equal(stubborn.body.code, null);
  assert.ok(elapsed < 10_000, `exec waited ${elapsed}ms for a child that never honored SIGTERM`);

  const afterwards = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "true" });
  assert.equal(afterwards.status, 200, "a killed command must release its slot");
});

test("exec rejects a missing command, an unknown session and an exited one", async (t) => {
  const server = await startServer(t);
  const session = await server.createSession();

  const missingCmd = await server.api("POST", `/v1/sessions/${session.id}/exec`, { args: ["nope"] });
  assert.equal(missingCmd.status, 400);
  assert.deepEqual(missingCmd.body, { error: "cmd is required" });

  const badTimeout = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "true", timeoutMs: 999_999 });
  assert.equal(badTimeout.status, 400);
  assert.deepEqual(badTimeout.body, { error: "timeoutMs is invalid" }, "a bad optional field must not be reported as a missing cmd");

  const unknownSession = await server.api("POST", "/v1/sessions/00000000-0000-4000-8000-000000000000/exec", { cmd: "true" });
  assert.equal(unknownSession.status, 404);
  assert.deepEqual(unknownSession.body, { error: "session not found" });

  const exiting = await server.createSession({ cmd: "sh", args: ["-c", "exit 0"] });
  await waitFor(async () => {
    const current = await server.api("GET", `/v1/sessions/${exiting.id}`);
    return current.body.exited === undefined ? undefined : true;
  });
  const exited = await server.api("POST", `/v1/sessions/${exiting.id}/exec`, { cmd: "true" });
  assert.equal(exited.status, 409);
  assert.deepEqual(exited.body, { error: "session has exited" });
});

test("exec follows the pty's current directory when asked, and falls back when it cannot", async (t) => {
  const server = await startServer(t);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ptys-exec-live-")));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "ptys-exec-elsewhere-")));
  const created = await server.api("POST", "/v1/workspaces", { path: workspace });
  const moved = join(elsewhere, "moved");
  const session = await server.createSession({
    workspaceId: created.body.id,
    cmd: "sh",
    args: ["-c", `cd ${elsewhere} && touch ${moved} && exec sleep 30`],
  });
  await waitFor(() => (existsSync(moved) ? true : undefined));

  const live = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "pwd", cwd: "live" });
  assert.ok([elsewhere, workspace].includes(live.body.cwd), live.body.cwd);
  assert.equal(live.body.stdout.trim(), live.body.cwd, "the response must report the directory it actually used");
  if (process.platform === "linux") {
    assert.equal(live.body.cwd, elsewhere, "procfs resolves a live cwd, so there is nothing to fall back to");
  }

  const spawnDirectory = await server.api("POST", `/v1/sessions/${session.id}/exec`, { cmd: "pwd" });
  assert.equal(spawnDirectory.body.cwd, workspace);
});

test("a live cwd that cannot be resolved falls back to the session's directory", async () => {
  const fallback = realpathSync(mkdtempSync(join(tmpdir(), "ptys-exec-fallback-")));
  assert.equal(await resolveLiveCwd(0x7ffffffe, fallback), fallback);
});

test("--disable-exec removes the route and clears the advertised capability", async (t) => {
  const enabled = await startServer(t);
  const enabledInfo = await enabled.api("GET", "/v1/info");
  assert.deepEqual(enabledInfo.body.capabilities, ["exec"]);
  const enabledSession = await enabled.createSession();
  const allowed = await enabled.api("POST", `/v1/sessions/${enabledSession.id}/exec`, { cmd: "true" });
  assert.equal(allowed.status, 200);

  const disabled = await startServer(t, ["--disable-exec"]);
  const disabledInfo = await disabled.api("GET", "/v1/info");
  assert.deepEqual(disabledInfo.body.capabilities, []);
  const disabledSession = await disabled.createSession();
  const refused = await disabled.api("POST", `/v1/sessions/${disabledSession.id}/exec`, { cmd: "true" });
  assert.equal(refused.status, 404);
  assert.deepEqual(refused.body, { error: "not found" });
});
