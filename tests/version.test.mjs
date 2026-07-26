import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHome, runCli } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(root, "dist", "cli.js");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the CLI reports the published package version", async () => {
  const home = isolatedHome("ptys-version-home-");
  for (const flag of ["--version", "-V"]) {
    const result = await runCli(cliPath, [flag], { home });
    assert.equal(result.code, 0, result.stderr);
    // The bundler inlines the manifest version, so a stale build shows up here rather than in a release.
    assert.equal(result.stdout.trim(), version);
  }
});
