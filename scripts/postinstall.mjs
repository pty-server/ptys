import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// npm runs postinstall in this repository too, where a fresh clone has no dist/ until the first build.
const entry = new URL("../dist/postinstall.js", import.meta.url);
if (existsSync(fileURLToPath(entry))) await import(entry.href);
