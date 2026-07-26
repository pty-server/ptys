import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** protocol first: the root package depends on it. */
export const PACKAGE_DIRS = ["packages/protocol", "."];

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Every path the package manifest promises to ship. A publish that lost its build would otherwise succeed
 * and burn the version number, which cannot be republished.
 */
export function missingEntryFiles(manifest, files) {
  const shipped = new Set(files.map((file) => file.path.replace(/^\.\//, "")));
  const required = [
    ...(typeof manifest.main === "string" ? [manifest.main] : []),
    ...(typeof manifest.types === "string" ? [manifest.types] : []),
    ...(typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {})),
  ].map((path) => path.replace(/^\.\//, ""));
  return [...new Set(required.filter((path) => !shipped.has(path)))];
}

/**
 * npm labels every publish `latest` unless told otherwise, prerelease or not. A prerelease published that
 * way would become what a plain `npm install` serves, so the dist tag is derived from the version instead
 * of defaulted: `0.1.0-rc.1` goes out as `next`, and only a final version claims `latest`.
 */
export function distTag(version) {
  return version.includes("-") ? "next" : "latest";
}

export function packPackage(dir) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: resolve(root, dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [pack] = JSON.parse(output);
  if (pack === undefined) throw new Error(`npm pack produced no tarball for ${dir}`);
  const manifest = JSON.parse(readFileSync(resolve(root, dir, "package.json"), "utf8"));
  const missing = missingEntryFiles(manifest, pack.files ?? []);
  if (missing.length > 0) {
    throw new Error(`${pack.name}@${pack.version} would ship without ${missing.join(", ")}; run the build first`);
  }
  return { dir, name: pack.name, version: pack.version, integrity: pack.integrity };
}

/**
 * The published manifest for exactly this version, or undefined when the version does not exist yet.
 * A registry error is never treated as "not published": that would republish over a live version.
 */
export async function fetchPublished({ name, version, registry = DEFAULT_REGISTRY, fetchImpl = fetch }) {
  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}/${version}`;
  const response = await fetchImpl(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`registry lookup for ${name}@${version} failed with HTTP ${response.status}`);
  const manifest = await response.json();
  return { integrity: manifest?.dist?.integrity, shasum: manifest?.dist?.shasum };
}

/**
 * Recovery after a partial release is a skip, not a republish, and only when the registry already holds
 * this exact artifact. A version that exists with different bytes is a release-stopping conflict.
 */
export function decide({ local, published }) {
  if (published === undefined) return { action: "publish" };
  if (published.integrity !== undefined && published.integrity === local.integrity) {
    return { action: "skip", reason: "already published with matching integrity" };
  }
  return {
    action: "conflict",
    reason: `${local.name}@${local.version} is already published with a different artifact (registry ${published.integrity ?? published.shasum ?? "unknown"}, local ${local.integrity}); publish a new version instead`,
  };
}

export async function planPublish({ dirs = PACKAGE_DIRS, registry = DEFAULT_REGISTRY, fetchImpl = fetch, packImpl = packPackage } = {}) {
  const plans = [];
  for (const dir of dirs) {
    const local = packImpl(dir);
    const published = await fetchPublished({ name: local.name, version: local.version, registry, fetchImpl });
    plans.push({ ...local, ...decide({ local, published }) });
  }
  return plans;
}

function publishPackage(dir, extraArgs) {
  execFileSync("npm", ["publish", ...extraArgs], { cwd: resolve(root, dir), stdio: "inherit" });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const registry = process.env.npm_config_registry ?? DEFAULT_REGISTRY;
  // Preflight covers every package before the first publish: a conflict found on the second package must
  // not be discovered after the first one is already public.
  const plans = await planPublish({ registry });
  const conflicts = plans.filter((plan) => plan.action === "conflict");
  if (conflicts.length > 0) {
    for (const conflict of conflicts) console.error(`::error::${conflict.reason}`);
    process.exitCode = 1;
    return;
  }
  for (const plan of plans) {
    if (plan.action === "skip") {
      console.log(`skipping ${plan.name}@${plan.version}: ${plan.reason}`);
      continue;
    }
    const tag = distTag(plan.version);
    console.log(`publishing ${plan.name}@${plan.version} as ${tag}${dryRun ? " (dry run)" : ""}`);
    publishPackage(plan.dir, ["--tag", tag, ...(dryRun ? ["--dry-run"] : [])]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
