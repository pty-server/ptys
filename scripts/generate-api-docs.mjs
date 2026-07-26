import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { createAsyncApiDocument, createOpenApiDocument } from "../packages/protocol/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const check = process.argv.includes("--check");
const documents = [
  [resolve(root, "docs/openapi.yaml"), createOpenApiDocument({ version: packageJson.version })],
  [resolve(root, "docs/asyncapi.yaml"), createAsyncApiDocument({ version: packageJson.version })],
];

let stale = false;
for (const [path, document] of documents) {
  const rendered = stringify(document, { lineWidth: 0 });
  if (check) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      stale = true;
      console.error(`Missing generated API document: ${path}`);
      continue;
    }
    if (existing !== rendered) {
      stale = true;
      console.error(`Generated API document is stale: ${path}`);
    }
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rendered);
}

if (stale) {
  console.error("Run npm run docs:generate and commit the resulting files.");
  process.exitCode = 1;
}
