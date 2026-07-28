import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPort, isolatedHome, registerTypeScriptResolution, runCli as runPtysCli, waitFor } from "./helpers.mjs";

registerTypeScriptResolution();

const { resolveDefaultShell } = await import("../src/server/default-shell.ts");

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

function runCli(args, home, env = {}) {
  return runPtysCli(cliPath, args, { home, env });
}

async function createSession(port) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  assert.equal(response.status, 200, `session create failed with ${response.status}`);
  return response.json();
}

async function reachable(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/v1/info`)).status === 200; } catch { return false; }
}

function killDaemon(home) {
  const path = join(home, ".ptys", "run", "default.pid");
  try {
    if (existsSync(path)) process.kill(JSON.parse(readFileSync(path, "utf8")).pid, "SIGKILL");
  } catch {}
}

test("passwd beats the SHELL a daemon inherited when it was started", () => {
  const frozen = { platform: "linux", env: { SHELL: "/bin/bash" }, passwdShell: () => "/bin/zsh" };

  assert.equal(resolveDefaultShell(undefined, frozen), "/bin/zsh");
  assert.equal(resolveDefaultShell("/usr/bin/fish", frozen), "/usr/bin/fish");
  // No passwd entry (containers do this), so the stale environment is still better than nothing.
  assert.equal(resolveDefaultShell(undefined, { ...frozen, passwdShell: () => undefined }), "/bin/bash");
  assert.equal(resolveDefaultShell(undefined, { platform: "linux", env: {}, passwdShell: () => undefined }), "/bin/sh");
  assert.equal(resolveDefaultShell(undefined, { platform: "win32", env: { ComSpec: "C:\\cmd.exe" } }), "C:\\cmd.exe");
});

test("a daemon serves the passwd shell, not the SHELL it was launched with", async (t) => {
  const passwd = userInfo().shell;
  if (typeof passwd !== "string" || passwd.length === 0) {
    t.skip("this user has no passwd shell to prefer");
    return;
  }
  // Never spawned, only inherited, so it just has to differ from the shell passwd reports.
  const decoy = passwd === "/bin/sh" ? "/bin/bash" : "/bin/sh";
  const home = isolatedHome("ptys-shell-home-");
  const port = await getPort();
  t.after(() => killDaemon(home));

  const started = await runCli(["server", "start", "--no-auth", "--listen", `127.0.0.1:${port}`], home, { SHELL: decoy });
  assert.equal(started.code, 0, started.stderr);
  await waitFor(async () => (await reachable(port)) ? true : undefined);

  const session = await createSession(port);
  assert.equal(session.cmd, passwd);

  assert.equal((await runCli(["server", "stop"], home)).code, 0);
});

test("--shell overrides passwd and survives a restart", async (t) => {
  const home = isolatedHome("ptys-shell-override-home-");
  const port = await getPort();
  t.after(() => killDaemon(home));

  const started = await runCli(["server", "start", "--no-auth", "--listen", `127.0.0.1:${port}`, "--shell", "/bin/sh"], home);
  assert.equal(started.code, 0, started.stderr);
  await waitFor(async () => (await reachable(port)) ? true : undefined);
  assert.equal((await createSession(port)).cmd, "/bin/sh");

  // The pidfile is what a restart replays, so an override that is not persisted silently disappears here.
  const restarted = await runCli(["server", "restart"], home);
  assert.equal(restarted.code, 0, restarted.stderr);
  await waitFor(async () => (await reachable(port)) ? true : undefined);
  assert.equal((await createSession(port)).cmd, "/bin/sh");

  assert.equal((await runCli(["server", "stop"], home)).code, 0);
});

test("an empty --shell is a usage error, not a silent fallback", async () => {
  const home = isolatedHome("ptys-shell-invalid-home-");

  const result = await runCli(["server", "start", "--shell", ""], home);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /shell must be a non-empty string/);
});
