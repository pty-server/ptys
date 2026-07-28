import { isLoopbackHost } from "./auth.js";
import { isValidOrigin } from "./origin-allowlist.js";
import { validateInstanceName } from "../paths.js";

export interface ListenAddress {
  host: string;
  port: number;
}

export function parseListenAddress(value: string): ListenAddress {
  const address = value.trim();
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(address);
  const separator = address.lastIndexOf(":");
  const [host, port] = bracketed !== null
    ? [bracketed[1], bracketed[2]]
    : [address.slice(0, separator), address.slice(separator + 1)];

  if (bracketed === null && (separator <= 0 || host.includes(":"))) {
    throw new Error(`listen address must be host:port, with IPv6 bracketed as [::1]:7801: ${value}`);
  }
  if (!/^\d+$/.test(port)) {
    throw new Error(`listen address must end in a port number: ${value}`);
  }
  return { host, port: Number(port) };
}

export function formatListenAddress(address: ListenAddress): string {
  return `${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}`;
}

export interface EffectiveServerOptions {
  instance?: string;
  listen?: ListenAddress[];
  noAuth?: boolean;
  allowOrigins?: string[];
  scrollback?: number;
  maxClosedSessions?: number;
  shell?: string;
}

export function validateServerOptions(options: EffectiveServerOptions): void {
  const { instance, listen, noAuth, allowOrigins, scrollback, maxClosedSessions, shell } = options;

  if (instance !== undefined) {
    validateInstanceName(instance);
  }
  const seen = new Set<string>();
  for (const address of listen ?? []) {
    if (typeof address.host !== "string" || address.host.length === 0) {
      throw new Error("listen host must be a non-empty string");
    }
    if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
      throw new Error("listen port must be an integer from 1 to 65535");
    }
    const key = `${address.host}:${address.port}`;
    if (seen.has(key)) {
      throw new Error(`duplicate listen address ${key}`);
    }
    seen.add(key);
    if (noAuth === true && !isLoopbackHost(address.host)) {
      throw new Error(
        `--no-auth requires a loopback host (127.0.0.1, ::1, localhost); refusing to bind ${address.host} without auth`,
      );
    }
  }
  for (const origin of allowOrigins ?? []) {
    if (!isValidOrigin(origin)) {
      throw new Error(`allowed origin must be an absolute http(s) origin without a path: ${origin}`);
    }
  }
  if (scrollback !== undefined && (!Number.isSafeInteger(scrollback) || scrollback < 0)) {
    throw new Error("scrollback must be a non-negative integer");
  }
  if (maxClosedSessions !== undefined && (!Number.isSafeInteger(maxClosedSessions) || maxClosedSessions < 0)) {
    throw new Error("maxClosedSessions must be a non-negative integer");
  }
  if (shell !== undefined && (typeof shell !== "string" || shell.length === 0)) {
    throw new Error("shell must be a non-empty string");
  }
}
