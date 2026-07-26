import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, runCli as runPtysCli } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

const REMOTE = "ptys.invalid:7801";

function runCli(args, environment = {}) {
  return runPtysCli(cliPath, args, {
    home: isolatedHome("ptys-address-home-"),
    env: { PTYS_TOKEN: "test-token", PTYS_INSECURE: undefined, ...environment },
  });
}

const REFUSAL = /refusing plaintext http:\/\/ to non-loopback host/;

test("plaintext http to a non-loopback host is refused", async () => {
  const result = await runCli(["list", "--server", `http://${REMOTE}`]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, REFUSAL);
  assert.match(result.stderr, /--insecure \/ PTYS_INSECURE=1/);
});

test("a scheme-less non-loopback address is refused too", async () => {
  const result = await runCli(["list", "--server", REMOTE]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, REFUSAL);
});

test("PTYS_SERVER is checked the same as --server", async () => {
  const result = await runCli(["list"], { PTYS_SERVER: REMOTE });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, REFUSAL);
});

test("attach refuses plaintext before opening a socket", async () => {
  const result = await runCli(["attach", "some-session", "--server", REMOTE]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, REFUSAL);
});

test("loopback addresses are exempt", async () => {
  for (const address of ["http://127.0.0.1:7801", "http://localhost:7801", "http://127.0.0.2:7801", "http://[::1]:7801"]) {
    const result = await runCli(["list", "--server", address]);
    assert.doesNotMatch(result.stderr, REFUSAL, `${address} must not be refused`);
  }
});

test("https to a non-loopback host is allowed", async () => {
  const result = await runCli(["list", "--server", `https://${REMOTE}`]);
  assert.doesNotMatch(result.stderr, REFUSAL);
});

test("--insecure lifts the refusal", async () => {
  const result = await runCli(["list", "--server", REMOTE, "--insecure"]);
  assert.doesNotMatch(result.stderr, REFUSAL);
});

test("PTYS_INSECURE=1 lifts the refusal", async () => {
  const result = await runCli(["list", "--server", REMOTE], { PTYS_INSECURE: "1" });
  assert.doesNotMatch(result.stderr, REFUSAL);
});
