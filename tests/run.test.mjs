import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, pickPort, runCli as runPtysCli, spawnPtys, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

function runCli(args, home) {
  return runPtysCli(cliPath, args, { home });
}

function startServer(port, home, extraArgs = []) {
  const proc = spawnPtys(cliPath, ["server", "--no-auth", "--listen", `127.0.0.1:${port}`, ...extraArgs], { home });
  let stdout = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk));
  return { proc, get stdout() { return stdout; } };
}

async function waitListening(handle) {
  await waitFor(() => handle.stdout.includes("listening") ? true : undefined);
}

function waitExit(proc) {
  return new Promise((resolve) => proc.on("close", resolve));
}

async function withServer(callback, extraArgs = []) {
  const home = isolatedHome();
  const port = pickPort();
  const handle = startServer(port, home, extraArgs);
  try {
    await waitListening(handle);
    await callback({ home, port });
  } finally {
    const exited = waitExit(handle.proc);
    handle.proc.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

test("run creates a session and attaches its output", async () => {
  await withServer(async ({ home, port }) => {
    const result = await runCli(["run", "--server", `127.0.0.1:${port}`, "--", "echo", "hello"], home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /ptys: session [0-9a-f-]+/);
  });
});

test("run returns the session exit code", async () => {
  await withServer(async ({ home, port }) => {
    const result = await runCli(["run", "--server", `127.0.0.1:${port}`, "--", "sh", "-c", "exit 3"], home);
    assert.equal(result.code, 3, result.stderr);
  });
});

test("run works with no -- separator at all", async () => {
  await withServer(async ({ home, port }) => {
    const result = await runCli(["run", "--server", `127.0.0.1:${port}`, "echo", "hello"], home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /hello/);
    assert.match(result.stderr, /ptys: session [0-9a-f-]+/);
  });
});

test("session creation without a workspace or command creates a default workspace and shell", async () => {
  await withServer(async ({ port }) => {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(typeof created.cmd, "string");
    assert.ok(created.cmd.length > 0);

    const workspacesResponse = await fetch(`http://127.0.0.1:${port}/v1/workspaces`);
    assert.equal(workspacesResponse.status, 200);
    const workspaces = await workspacesResponse.json();
    assert.equal(workspaces.length, 1);
    assert.equal(created.workspaceId, workspaces[0].id);
  });
});

test("start without a command uses the default shell", async () => {
  await withServer(async ({ home, port }) => {
    const started = await runCli(["start", "--server", `127.0.0.1:${port}`], home);
    assert.equal(started.code, 0, started.stderr);

    const listed = await runCli(["list", "--server", `127.0.0.1:${port}`, "--json"], home);
    assert.equal(listed.code, 0, listed.stderr);
    const sessions = JSON.parse(listed.stdout);
    assert.equal(sessions.length, 1);
    assert.equal(typeof sessions[0].cmd, "string");
    assert.ok(sessions[0].cmd.length > 0);
  });
});

test("rename updates a session name", async () => {
  await withServer(async ({ home, port }) => {
    const server = `127.0.0.1:${port}`;
    const started = await runCli(["start", "--server", server, "--", "sleep", "1"], home);
    assert.equal(started.code, 0, started.stderr);
    const sessionId = /started session (\S+)/.exec(started.stdout)?.[1];
    assert.ok(sessionId, `expected session id in: ${started.stdout}`);

    const renamed = await runCli(["rename", "--server", server, sessionId, "editor"], home);
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.match(renamed.stdout, /renamed session .* to editor/);

    const listed = await runCli(["list", "--server", server, "--json"], home);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).find((session) => session.id === sessionId)?.name, "editor");
  });
});

test("CLI help and session list do not expose workspace implementation details", async () => {
  await withServer(async ({ home, port }) => {
    const startHelp = await runCli(["start", "--help"], home);
    assert.equal(startHelp.code, 0, startHelp.stderr);
    assert.doesNotMatch(startHelp.stdout, /workspace/i);
    assert.match(startHelp.stdout, /starting directory/);

    const serverHelp = await runCli(["server", "--help"], home);
    assert.equal(serverHelp.code, 0, serverHelp.stderr);
    assert.match(serverHelp.stdout, /run \[options\]/);

    const started = await runCli(["start", "--server", `127.0.0.1:${port}`, "--", "sleep", "1"], home);
    assert.equal(started.code, 0, started.stderr);
    const listed = await runCli(["list", "--server", `127.0.0.1:${port}`], home);
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout.split("\n", 1)[0], /workspace/i);
    assert.match(listed.stdout, /DIRECTORY/);
    assert.ok(listed.stdout.includes(projectRoot.replace(/\/$/, "")));
    assert.match(listed.stdout, /STATUS/);
  });
});

test("human-readable session list strips terminal control characters", async () => {
  await withServer(async ({ home, port }) => {
    const server = `127.0.0.1:${port}`;
    const name = "red\x1b[31m\nline";
    const started = await runCli(["start", "--server", server, "--name", name, "--", "sleep", "1"], home);
    assert.equal(started.code, 0, started.stderr);

    const listed = await runCli(["list", "--server", server], home);
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /\x1b/);
    assert.match(listed.stdout, /red\[31mline/);
    assert.equal(listed.stdout.trimEnd().split("\n").length, 2);
  });
});

test("sessions without --cwd use the server working directory", async () => {
  const selectedDirectory = mkdtempSync(join(tmpdir(), "ptys-run-cwd-"));
  try {
    await withServer(async ({ home, port }) => {
      const selected = await runCli([
        "start", "--server", `127.0.0.1:${port}`, "--cwd", selectedDirectory, "--", "sleep", "1",
      ], home);
      assert.equal(selected.code, 0, selected.stderr);

      const result = await runCli([
        "run", "--server", `127.0.0.1:${port}`, "--", "sh", "-c", "pwd",
      ], home);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes(projectRoot.replace(/\/$/, "")));
    });
  } finally {
    rmSync(selectedDirectory, { recursive: true, force: true });
  }
});

test("run: ptys options before the command still parse while the command's own args pass through", async () => {
  await withServer(async ({ home, port }) => {
    const result = await runCli(
      ["run", "--server", `127.0.0.1:${port}`, "--name", "smoke", "sh", "-c", "echo hi"],
      home,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /hi/);

    const list = await runCli(["list", "--server", `127.0.0.1:${port}`, "--json"], home);
    const sessions = JSON.parse(list.stdout);
    assert.ok(sessions.some((session) => session.name === "smoke"));
  });
});

test("run collects a command that exits immediately under zero retention", async () => {
  await withServer(async ({ home, port }) => {
    const result = await runCli(["run", "--server", `127.0.0.1:${port}`, "--", "/bin/true"], home);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    assert.doesNotMatch(result.stderr, /No session matches/);

    const output = await runCli(["run", "--server", `127.0.0.1:${port}`, "--", "sh", "-c", "printf gone"], home);
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /gone/);
  }, ["--max-closed-sessions", "0"]);
});

test("a session attached once is reaped under zero retention", async () => {
  await withServer(async ({ home, port }) => {
    const result = await runCli(["run", "--server", `127.0.0.1:${port}`, "--", "/bin/true"], home);
    assert.equal(result.code, 0, result.stderr);
    const sessionId = /ptys: session ([0-9a-f-]+)/.exec(result.stderr)[1];

    const list = await runCli(["list", "--server", `127.0.0.1:${port}`, "--json"], home);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).filter((session) => session.id === sessionId), []);
  }, ["--max-closed-sessions", "0"]);
});

test("workspace creation rejects a path that is not a directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ptys-workspace-file-"));
  const file = join(directory, "regular");
  writeFileSync(file, "");
  try {
    await withServer(async ({ port }) => {
      const post = (path) => fetch(`http://127.0.0.1:${port}/v1/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });

      const notADirectory = await post(file);
      assert.equal(notADirectory.status, 400);
      assert.deepEqual(await notADirectory.json(), { error: "path is not a directory" });

      const missing = await post(join(directory, "absent"));
      assert.equal(missing.status, 400);
      assert.deepEqual(await missing.json(), { error: "path does not exist" });

      const listed = await fetch(`http://127.0.0.1:${port}/v1/workspaces`);
      assert.deepEqual(await listed.json(), []);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
