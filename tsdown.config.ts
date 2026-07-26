import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  // tsdown would emit .mjs for esm; `bin` points at dist/cli.js and the package is already "type": "module".
  outExtensions: () => ({ js: ".js" }),
  clean: true,
  sourcemap: false,
  dts: false,
  shims: true,
  // Never bundled: native addon. Always bundled: the workspace protocol package, so the
  // published CLI does not need @pty-server/protocol resolved at runtime.
  deps: {
    neverBundle: ["node-pty"],
    alwaysBundle: ["@pty-server/protocol"],
  },
  // tsdown writes package.json exports/bin fields when enabled; this repo maintains them by hand.
  exports: false,
  define: {
    __PTYS_VERSION__: JSON.stringify(version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
