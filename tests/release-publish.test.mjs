import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { decide, distTag, fetchPublished, missingEntryFiles, planPublish } from "../scripts/publish-workspaces.mjs";

function fakeRegistry(t, handler) {
  const server = createServer(handler);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test("an unpublished version is published and a byte-identical one is skipped", () => {
  const local = { name: "@pty-server/protocol", version: "1.0.0", integrity: "sha512-aaa" };
  assert.equal(decide({ local, published: undefined }).action, "publish");
  assert.equal(decide({ local, published: { integrity: "sha512-aaa" } }).action, "skip");
});

test("a prerelease never claims the latest dist tag", () => {
  assert.equal(distTag("0.1.0-rc.1"), "next");
  assert.equal(distTag("1.0.0-next.0"), "next");
  assert.equal(distTag("0.1.0"), "latest");
  assert.equal(distTag("1.2.3"), "latest");
});

test("a published version with a different artifact is a conflict, not a skip", () => {
  const local = { name: "@pty-server/ptys", version: "1.0.0", integrity: "sha512-local" };
  const outcome = decide({ local, published: { integrity: "sha512-registry" } });
  assert.equal(outcome.action, "conflict");
  assert.match(outcome.reason, /already published with a different artifact/);
  // A registry that reports only a legacy shasum cannot prove the artifact matches.
  assert.equal(decide({ local, published: { shasum: "abc" } }).action, "conflict");
});

test("a missing build output is refused before anything is published", () => {
  const manifest = { bin: { ptys: "dist/cli.js" }, main: "./dist/index.js", types: "./dist/index.d.ts" };
  assert.deepEqual(missingEntryFiles(manifest, [{ path: "dist/cli.js" }, { path: "dist/index.js" }, { path: "dist/index.d.ts" }]), []);
  assert.deepEqual(missingEntryFiles(manifest, [{ path: "package.json" }]), ["dist/index.js", "dist/index.d.ts", "dist/cli.js"]);
});

test("a 404 means unpublished while any other registry failure stops the release", async (t) => {
  const registry = await fakeRegistry(t, (request, response) => {
    if (request.url === "/@scope%2fmissing/1.0.0") {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.url === "/@scope%2fpresent/1.0.0") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ dist: { integrity: "sha512-published" } }));
      return;
    }
    response.writeHead(500).end("boom");
  });

  assert.equal(await fetchPublished({ name: "@scope/missing", version: "1.0.0", registry }), undefined);
  assert.deepEqual(await fetchPublished({ name: "@scope/present", version: "1.0.0", registry }), {
    integrity: "sha512-published",
    shasum: undefined,
  });
  await assert.rejects(
    fetchPublished({ name: "@scope/broken", version: "1.0.0", registry }),
    /registry lookup for @scope\/broken@1.0.0 failed with HTTP 500/,
  );
});

test("the plan preflights every package before the first publish", async (t) => {
  const packed = {
    "packages/protocol": { dir: "packages/protocol", name: "@pty-server/protocol", version: "1.0.0", integrity: "sha512-protocol" },
    ".": { dir: ".", name: "@pty-server/ptys", version: "1.0.0", integrity: "sha512-root" },
  };
  const registry = await fakeRegistry(t, (request, response) => {
    // protocol was published by a previous, partially failed run; root exists with foreign bytes.
    const body = request.url.includes("protocol")
      ? { dist: { integrity: "sha512-protocol" } }
      : { dist: { integrity: "sha512-someone-else" } };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });

  const plans = await planPublish({ registry, packImpl: (dir) => packed[dir] });
  assert.deepEqual(plans.map((plan) => [plan.name, plan.action]), [
    ["@pty-server/protocol", "skip"],
    ["@pty-server/ptys", "conflict"],
  ]);
});
