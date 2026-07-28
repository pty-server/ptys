import { ensureExecutable, spawnHelperPaths } from "./spawn-helper.js";

// Best effort by design: a read-only or root-owned install must not fail `npm install`, and the server
// repairs (or reports) the helper it actually needs when it starts.
for (const path of spawnHelperPaths()) {
  try {
    if (ensureExecutable(path)) console.log(`ptys: made ${path} executable`);
  } catch (error) {
    console.warn(`ptys: ${error instanceof Error ? error.message : String(error)}`);
  }
}
