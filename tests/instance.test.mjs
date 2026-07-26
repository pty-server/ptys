import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, runCli as runPtysCli } from "./helpers.mjs";

const cliPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");

function runDir(home) { return join(home, ".ptys", "run"); }

function runCli(args, home, env = {}) {
  return runPtysCli(cliPath, args, { home, env });
}

test("two socket-only instances run side by side and are reached by name", async (t) => {
  const home = isolatedHome("ptys-instance-home-");
  t.after(() => runCli(["server", "stop", "--all"], home));

  for (const instance of ["work", "play"]) {
    const started = await runCli(["server", "start", "--instance", instance], home);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`daemon started as instance ${instance}`));
    assert.equal(existsSync(join(runDir(home), `${instance}.sock`)), true);
  }

  const created = await runCli(["start", "--instance", "work", "--name", "only-in-work", "sleep", "30"], home);
  assert.equal(created.code, 0, created.stderr);

  const work = await runCli(["list", "--instance", "work"], home);
  assert.match(work.stdout, /only-in-work/);
  const play = await runCli(["list", "--instance", "play"], home);
  assert.doesNotMatch(play.stdout, /only-in-work/);

  const status = await runCli(["server", "status", "--json"], home);
  assert.deepEqual(JSON.parse(status.stdout).map((entry) => entry.instance).sort(), ["play", "work"]);

  const stopped = await runCli(["server", "stop", "--instance", "work"], home);
  assert.equal(stopped.code, 0, stopped.stderr);
  const remaining = await runCli(["server", "status", "--json"], home);
  assert.deepEqual(JSON.parse(remaining.stdout).map((entry) => entry.instance), ["play"]);
});

test("PTYS_INSTANCE names the instance a client reaches", async (t) => {
  const home = isolatedHome("ptys-instance-home-");
  t.after(() => runCli(["server", "stop", "--all"], home));

  const started = await runCli(["server", "start", "--instance", "from-env"], home);
  assert.equal(started.code, 0, started.stderr);

  const list = await runCli(["list"], home, { PTYS_INSTANCE: "from-env" });
  assert.equal(list.code, 0, list.stderr);
  const missing = await runCli(["list"], home);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /no ptys server for instance default/);
});

test("an unusable instance name is refused before anything is created", async () => {
  for (const instance of ["../escape", "with/slash", ".hidden", ""]) {
    const home = isolatedHome("ptys-instance-home-");
    const result = await runCli(["server", "start", "--instance", instance], home);
    assert.notEqual(result.code, 0, `${instance} should be refused: ${result.stdout}`);
    assert.match(result.stderr, /instance must start with a letter or digit/);
    assert.deepEqual(existsSync(runDir(home)) ? readdirSync(runDir(home)) : [], []);
  }
});

test("~/.ptys.json can name the instance, and rejects an unusable one", async (t) => {
  const home = isolatedHome("ptys-instance-home-");
  t.after(() => runCli(["server", "stop", "--all"], home));
  writeFileSync(join(home, ".ptys.json"), JSON.stringify({ instance: "configured" }));

  const started = await runCli(["server", "start"], home);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /daemon started as instance configured/);
  const stopped = await runCli(["server", "stop"], home);
  assert.equal(stopped.code, 0, stopped.stderr);

  writeFileSync(join(home, ".ptys.json"), JSON.stringify({ instance: "../escape" }));
  const refused = await runCli(["server", "start"], home);
  assert.notEqual(refused.code, 0, refused.stdout);
  assert.match(refused.stderr, /instance must start with a letter or digit/);
});

test("--instance and --server together are refused rather than silently ranked", async () => {
  const home = isolatedHome("ptys-instance-home-");
  const result = await runCli(["list", "--instance", "work", "--server", "127.0.0.1:7801"], home);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /pass only one/);
});
