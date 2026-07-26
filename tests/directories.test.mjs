import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPort, isolatedHome, runCli as runPtysCli, spawnPtys, waitFor } from "./helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(projectRoot, "dist", "cli.js");

async function startServer(args, home = isolatedHome()) {
  const port = await getPort();
  const proc = spawnPtys(cliPath, ["server", "--listen", `127.0.0.1:${port}`, ...args], { home });
  let stdout = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  return { proc, home, baseUrl: `http://127.0.0.1:${port}`, get stdout() { return stdout; } };
}

function runCli(args, home = isolatedHome()) {
  return runPtysCli(cliPath, args, { home }).then(({ code, stderr }) => ({ code, stderr }));
}

async function api(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, { headers: token ? { authorization: `Bearer ${token}`, origin: "http://picker.test" } : {} });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("directory browser is authenticated, CORS-enabled, paginated, and contained", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptys-directory-root-"));
  const outside = mkdtempSync(join(tmpdir(), "ptys-directory-outside-"));
  mkdirSync(join(root, "nested"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "file.txt"), "not a directory");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(root, "missing"), join(root, "broken"));
  for (let index = 0; index < 105; index++) mkdirSync(join(root, `page-${String(index).padStart(3, "0")}`));
  const token = "directory-browser-token";
  const handle = await startServer(["--token", token, "--allow-origin", "http://picker.test", "--browse-root", root]);
  await waitFor(() => handle.stdout.includes("listening") ? true : undefined);

  try {
    const unauthenticated = await api(handle.baseUrl, "/v1/directories");
    assert.equal(unauthenticated.status, 401);

    const roots = await api(handle.baseUrl, "/v1/directories", token);
    assert.equal(roots.status, 200);
    assert.equal(roots.headers.get("access-control-allow-origin"), "http://picker.test");
    assert.deepEqual(roots.body.entries, [{ name: basename(root), path: realpathSync(root) }]);

    const first = await api(handle.baseUrl, `/v1/directories?path=${encodeURIComponent(root)}&q=page-`, token);
    assert.equal(first.status, 200);
    assert.equal(first.body.current.path, realpathSync(root));
    assert.equal(first.body.entries.length, 100);
    assert.ok(first.body.nextCursor);
    const second = await api(handle.baseUrl, `/v1/directories?path=${encodeURIComponent(root)}&q=page-&cursor=${encodeURIComponent(first.body.nextCursor)}`, token);
    assert.equal(second.status, 200);
    assert.equal(second.body.entries.length, 5);
    assert.equal(second.body.nextCursor, undefined);

    const all = await api(handle.baseUrl, `/v1/directories?path=${encodeURIComponent(root)}`, token);
    const names = all.body.entries.map((entry) => entry.name);
    assert.ok(names.includes(".hidden"));
    assert.ok(names.includes("nested"));
    assert.ok(!names.includes("file.txt"));
    assert.ok(!names.includes("escape"));
    assert.ok(!names.includes("broken"));

    const nested = await api(handle.baseUrl, `/v1/directories?path=${encodeURIComponent(join(root, "nested"))}`, token);
    assert.deepEqual(
      nested.body.breadcrumbs.map((entry) => entry.path),
      [realpathSync(root), realpathSync(join(root, "nested"))],
    );

    const escaped = await api(handle.baseUrl, `/v1/directories?path=${encodeURIComponent(join(root, "..", basename(outside)))}`, token);
    assert.deepEqual(escaped, { status: 400, headers: escaped.headers, body: { error: "directory unavailable" } });
  } finally {
    handle.proc.kill();
  }
});

test("directory browser defaults to the server user's home directory", async () => {
  const home = isolatedHome();
  const token = "default-home-browser-token";
  const handle = await startServer(["--token", token], home);
  await waitFor(() => handle.stdout.includes("listening") ? true : undefined);
  try {
    const roots = await api(handle.baseUrl, "/v1/directories", token);
    assert.equal(roots.status, 200);
    assert.deepEqual(roots.body.entries, [{ name: basename(home), path: realpathSync(home) }]);
  } finally {
    handle.proc.kill();
  }
});

test("server rejects relative and non-directory browse roots before listening", async () => {
  const relative = await runCli(["server", "--no-auth", "--browse-root", "relative"]);
  assert.notEqual(relative.code, 0);
  assert.match(relative.stderr, /browse root must be an absolute path/);

  const file = join(mkdtempSync(join(tmpdir(), "ptys-directory-file-")), "file");
  writeFileSync(file, "not a directory");
  const notDirectory = await runCli(["server", "--no-auth", "--browse-root", file]);
  assert.notEqual(notDirectory.code, 0);
  assert.match(notDirectory.stderr, /browse root is not an existing directory/);
});

test("pagination keeps canonically equivalent names across a page boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "ptys-directory-unicode-"));
  const composed = "zcafé";      // café, single code point
  const decomposed = "zcafé";   // café, e + combining acute
  mkdirSync(join(root, composed));
  mkdirSync(join(root, decomposed));

  const distinct = readdirSync(root).length === 2;
  if (!distinct) return;

  for (let index = 0; index < 99; index++) mkdirSync(join(root, `filler-${String(index).padStart(3, "0")}`));
  const token = "unicode-pagination-token";
  const handle = await startServer(["--token", token, "--browse-root", root]);
  await waitFor(() => handle.stdout.includes("listening") ? true : undefined);

  try {
    const collected = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const query = `path=${encodeURIComponent(root)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await api(handle.baseUrl, `/v1/directories?${query}`, token);
      assert.equal(response.status, 200);
      collected.push(...response.body.entries.map((entry) => entry.name));
      cursor = response.body.nextCursor;
      if (cursor === undefined) break;
    }

    assert.equal(cursor, undefined, "pagination did not terminate");
    assert.equal(collected.length, 101, `expected every entry exactly once, got ${collected.length}`);
    assert.deepEqual([...new Set(collected)].length, 101, "an entry was returned twice");
    assert.ok(collected.includes(composed), "the composed spelling went missing");
    assert.ok(collected.includes(decomposed), "the decomposed spelling went missing");
  } finally {
    handle.proc.kill();
  }
});
