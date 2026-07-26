import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const tokenDirectory = join(homedir(), ".ptys");
const tokenPath = join(tokenDirectory, "token");

export function getOrCreateToken(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const fromEnv = process.env.PTYS_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  mkdirSync(tokenDirectory, { recursive: true, mode: 0o700 });

  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf8").trim();
  }

  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  process.stderr.write(`ptys: generated auth token, saved to ${tokenPath}\n`);
  process.stderr.write(`ptys: token: ${token}\n`);
  return token;
}

export function verifyToken(presented: string | undefined, actual: string): boolean {
  if (presented === undefined || presented.length === 0) {
    return false;
  }
  const presentedDigest = createHash("sha256").update(presented).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(presentedDigest, actualDigest);
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}

export const SUBPROTOCOL_PREFIX = "ptys.bearer.";

export function extractSubprotocolToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value === undefined) {
    return undefined;
  }
  for (const offer of value.split(",")) {
    const trimmed = offer.trim();
    if (trimmed.startsWith(SUBPROTOCOL_PREFIX) && trimmed.length > SUBPROTOCOL_PREFIX.length) {
      return trimmed.slice(SUBPROTOCOL_PREFIX.length);
    }
  }
  return undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }
  return /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}
