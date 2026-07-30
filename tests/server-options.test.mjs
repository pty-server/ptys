
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPort, isolatedHome, registerTypeScriptResolution, runCli as runPtysCli } from "./helpers.mjs";

process.env.HOME = isolatedHome("ptys-options-home-");

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

registerTypeScriptResolution();

const { validateServerOptions } = await import("../src/server/server-options.ts");

function runCli(args, home) {
  return runPtysCli(cliPath, args, { home });
}

test("validateServerOptions accepts effective defaults and rejects each bad value", () => {
  validateServerOptions({
    instance: "default",
    listen: [{ host: "127.0.0.1", port: 7801 }],
    noAuth: true,
    allowOrigins: ["http://localhost:5173"],
    scrollback: 0,
    maxClosedSessions: 0,
    disableExec: false,
  });
  validateServerOptions({ instance: "default", listen: [], noAuth: true });

  assert.throws(() => validateServerOptions({ instance: "../escape" }), /instance must start with a letter or digit/);
  assert.throws(() => validateServerOptions({ instance: "" }), /instance must start with a letter or digit/);
  assert.throws(() => validateServerOptions({ listen: [{ host: "", port: 7801 }] }), /listen host must be a non-empty string/);
  assert.throws(() => validateServerOptions({ listen: [{ host: "127.0.0.1", port: 0 }] }), /listen port must be an integer from 1 to 65535/);
  assert.throws(() => validateServerOptions({ listen: [{ host: "127.0.0.1", port: Number.NaN }] }), /listen port must be an integer from 1 to 65535/);
  assert.throws(() => validateServerOptions({ listen: [{ host: "127.0.0.1", port: 70000 }] }), /listen port must be an integer from 1 to 65535/);
  assert.throws(
    () => validateServerOptions({ listen: [{ host: "127.0.0.1", port: 7801 }, { host: "127.0.0.1", port: 7801 }] }),
    /duplicate listen address 127\.0\.0\.1:7801/,
  );
  assert.throws(() => validateServerOptions({ noAuth: true, listen: [{ host: "0.0.0.0", port: 7801 }] }), /--no-auth requires a loopback host/);
  assert.throws(() => validateServerOptions({ allowOrigins: ["localhost:5173"] }), /allowed origin must be an absolute http\(s\) origin/);
  assert.throws(() => validateServerOptions({ allowOrigins: ["http://localhost:5173/app"] }), /allowed origin must be an absolute http\(s\) origin/);
  assert.throws(() => validateServerOptions({ scrollback: -1 }), /scrollback must be a non-negative integer/);
  assert.throws(() => validateServerOptions({ scrollback: 1.5 }), /scrollback must be a non-negative integer/);
  assert.throws(() => validateServerOptions({ maxClosedSessions: -1 }), /maxClosedSessions must be a non-negative integer/);
  assert.throws(() => validateServerOptions({ disableExec: "yes" }), /disableExec must be a boolean/);
});

test("a foreground server refuses to start on a bad flag value", async () => {
  const cases = [
    { args: ["--listen", "127.0.0.1:0"], expected: /listen port must be an integer from 1 to 65535/ },
    { args: ["--listen", "127.0.0.1:abc"], expected: /listen address must end in a port number/ },
    { args: ["--listen", "7801"], expected: /listen address must be host:port/ },
    { args: ["--instance", "../escape"], expected: /instance must start with a letter or digit/ },
    { args: ["--listen", `127.0.0.1:${await getPort()}`, "--scrollback", "-5"], expected: /scrollback must be a non-negative integer/ },
    { args: ["--listen", `127.0.0.1:${await getPort()}`, "--max-closed-sessions", "1.5"], expected: /maxClosedSessions must be a non-negative integer/ },
    { args: ["--listen", `127.0.0.1:${await getPort()}`, "--allow-origin", "bogus"], expected: /allowed origin must be an absolute http\(s\) origin/ },
  ];
  for (const { args, expected } of cases) {
    const result = await runCli(["server", "--no-auth", ...args], isolatedHome("ptys-options-sub-"));
    assert.notEqual(result.code, 0, `expected a refusal for ${args.join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout, /listening/);
  }
});

test("a rejected daemon start spawns no child and leaves no pidfile", async () => {
  const home = isolatedHome("ptys-options-sub-");
  const result = await runCli(["server", "start", "--listen", "127.0.0.1:0"], home);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /listen port must be an integer from 1 to 65535/);

  const runDir = join(home, ".ptys", "run");
  assert.deepEqual(existsSync(runDir) ? readdirSync(runDir) : [], []);
});

test("an invalid value in ~/.ptys.json is refused on the same terms as a flag", async () => {
  const home = isolatedHome("ptys-options-sub-");
  writeFileSync(join(home, ".ptys.json"), JSON.stringify({ allowOrigins: ["example.com"] }));

  const result = await runCli(["server", "--no-auth", "--listen", `127.0.0.1:${await getPort()}`], home);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /allowed origin must be an absolute http\(s\) origin/);
});

test("~/.ptys.json rejects a non-boolean disableExec", async () => {
  const home = isolatedHome("ptys-options-sub-");
  writeFileSync(join(home, ".ptys.json"), JSON.stringify({ disableExec: "yes" }));

  const result = await runCli(["server", "--no-auth", "--listen", `127.0.0.1:${await getPort()}`], home);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /disableExec must be a boolean/);
});

test("~/.ptys.json rejects the removed host and port settings by name", async () => {
  const home = isolatedHome();
  writeFileSync(join(home, ".ptys.json"), JSON.stringify({ host: "127.0.0.1", port: 7801 }));

  const result = await runCli(["server"], home);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, /host is no longer a setting; use listen/);
});
