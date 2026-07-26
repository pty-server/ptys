import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateInstanceName } from "../paths.js";
import { parseListenAddress } from "../server/server-options.js";

export interface ServerDefaults {
  instance?: string;
  listen?: string[];
  noAuth?: boolean;
  allowOrigins?: string[];
  scrollback?: number;
  browseRoots?: string[];
  maxClosedSessions?: number;
}

export function configPath(): string {
  return join(homedir(), ".ptys.json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readServerDefaults(): ServerDefaults {
  const path = configPath();
  if (!existsSync(path)) return {};

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid ${path}: ${message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${path}: expected a JSON object`);
  }

  const config = value as Record<string, unknown>;
  const allowed = new Set(["instance", "listen", "noAuth", "allowOrigins", "scrollback", "browseRoots", "maxClosedSessions"]);
  for (const key of Object.keys(config)) {
    if (key === "host" || key === "port") {
      throw new Error(`invalid ${path}: ${key} is no longer a setting; use listen: ["127.0.0.1:7801"] to bind an address, and instance to name the server`);
    }
    if (!allowed.has(key)) throw new Error(`invalid ${path}: unknown setting ${key}`);
  }
  if (config.instance !== undefined) {
    if (typeof config.instance !== "string") {
      throw new Error(`invalid ${path}: instance must be a string`);
    }
    try {
      validateInstanceName(config.instance);
    } catch (error) {
      throw new Error(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (config.listen !== undefined) {
    if (!isStringArray(config.listen)) {
      throw new Error(`invalid ${path}: listen must be an array of host:port strings`);
    }
    for (const address of config.listen) {
      try {
        parseListenAddress(address);
      } catch (error) {
        throw new Error(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (config.noAuth !== undefined && typeof config.noAuth !== "boolean") {
    throw new Error(`invalid ${path}: noAuth must be a boolean`);
  }
  if (config.allowOrigins !== undefined && !isStringArray(config.allowOrigins)) {
    throw new Error(`invalid ${path}: allowOrigins must be an array of strings`);
  }
  if (config.scrollback !== undefined && !isNonNegativeInteger(config.scrollback)) {
    throw new Error(`invalid ${path}: scrollback must be a non-negative integer`);
  }
  if (config.browseRoots !== undefined && !isStringArray(config.browseRoots)) {
    throw new Error(`invalid ${path}: browseRoots must be an array of strings`);
  }
  if (config.maxClosedSessions !== undefined && !isNonNegativeInteger(config.maxClosedSessions)) {
    throw new Error(`invalid ${path}: maxClosedSessions must be a non-negative integer`);
  }
  return config as ServerDefaults;
}
