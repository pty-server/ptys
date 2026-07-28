import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registerTypeScriptResolution } from "./helpers.mjs";

registerTypeScriptResolution();

const { activeSpawnHelperPath, ensureExecutable, spawnHelperPaths } = await import("../src/spawn-helper.ts");

function helperFile(mode) {
  const path = join(mkdtempSync(join(tmpdir(), "ptys-helper-")), "spawn-helper");
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, mode);
  return path;
}

test("a helper shipped without the exec bit is repaired exactly once", () => {
  const path = helperFile(0o644);

  assert.equal(ensureExecutable(path), true);
  assert.equal(statSync(path).mode & 0o111, 0o111);
  assert.equal(ensureExecutable(path), false);
});

test("an executable helper is left alone", () => {
  const path = helperFile(0o700);

  assert.equal(ensureExecutable(path), false);
  assert.equal(statSync(path).mode & 0o777, 0o700);
});

test("an unrepairable helper reports the path it failed on", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "ptys-helper-")), "spawn-helper");

  assert.throws(() => ensureExecutable(missing), (error) => error.message.includes(missing));
});

test("only helpers that exist are listed, and the active one is among them", () => {
  const paths = spawnHelperPaths();

  for (const path of paths) {
    assert.equal(basename(path), "spawn-helper");
    assert.equal(existsSync(path), true);
  }
  const active = activeSpawnHelperPath();
  // Absent on platforms whose prebuild ships no helper, which is every Linux build.
  if (active !== undefined) assert.equal(paths.includes(active), true);
});
