
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "../src/server/session.ts";

test("PtySession snapshots truecolor output with Unicode 11 width rules", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ptys-unicode-truecolor-"));
  const inheritedTerm = process.env.TERM;
  const inheritedColorTerm = process.env.COLORTERM;
  delete process.env.TERM;
  delete process.env.COLORTERM;
  let session;
  try {
    session = new PtySession({
      id: "unicode-truecolor",
      workspaceId: "workspace",
      cwd,
      cmd: "sh",
      args: ["-c", "sleep 0.05; printf '\\033[38;2;255;100;0morange 😀 中\\033[0m\\nTERM=%s COLORTERM=%s\\n' \"$TERM\" \"$COLORTERM\""],
      cols: 80,
      rows: 24,
    });
  } finally {
    if (inheritedTerm === undefined) delete process.env.TERM;
    else process.env.TERM = inheritedTerm;
    if (inheritedColorTerm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = inheritedColorTerm;
  }
  let output = "";
  let resolveOutput;
  const outputReady = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for PTY output: ${output}`)), 1000);
    resolveOutput = () => {
      clearTimeout(deadline);
      resolve();
    };
  });
  let resolveExit;
  const exited = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("timed out waiting for PTY exit")), 1000);
    resolveExit = () => {
      clearTimeout(deadline);
      resolve();
    };
  });
  const unsubscribe = session.onData((chunk) => {
    output += chunk;
    if (output.includes("COLORTERM=")) resolveOutput();
  });
  const unsubscribeExit = session.onExit(resolveExit);

  try {
    await outputReady;

    const text = await session.snapshot();
    await exited;
    assert.match(output, /TERM=xterm-256color/);
    assert.match(output, /COLORTERM=truecolor/);
    assert.match(text, /38;2;255;100;0/);
    assert.equal(session.unicodeVersion, "11");
  } finally {
    unsubscribe();
    unsubscribeExit();
    session.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});
