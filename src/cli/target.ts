import { existsSync } from "node:fs";
import { controlSocketCandidates, DEFAULT_INSTANCE, validateInstanceName } from "../paths.js";
import { CONTROL_SOCKET_SUPPORTED, isTrustedControlSocket } from "../server/control-socket.js";
import { resolveServerBaseUrl } from "./server-address.js";
import { resolveToken } from "./token.js";

export interface ServerTarget {
  baseUrl: string;
  socketPath?: string;
  token?: string;
}

export interface TargetOptions {
  server?: string;
  instance?: string;
  token?: string;
  insecure?: boolean;
}

export function resolveTarget(options: TargetOptions): ServerTarget {
  if (options.server !== undefined && options.instance !== undefined) {
    throw new Error("ptys: --instance names a local server and --server names an address; pass only one");
  }

  const environmentServer = process.env.PTYS_SERVER;
  const address = options.instance !== undefined
    ? undefined
    : options.server ?? (environmentServer === undefined || environmentServer.length === 0 ? undefined : environmentServer);

  if (address !== undefined || (options.instance === undefined && !CONTROL_SOCKET_SUPPORTED)) {
    const baseUrl = resolveServerBaseUrl(address, options.insecure);
    const token = resolveToken(options.token);
    return token === undefined ? { baseUrl } : { baseUrl, token };
  }

  const instance = resolveInstance(options.instance);
  const candidates = controlSocketCandidates(instance);
  // Connecting is the whole credential here, so a candidate counts only once it is proven to be this
  // user's own socket in a directory nobody else can write.
  const socketPath = candidates.find((path) => isTrustedControlSocket(path));
  if (socketPath === undefined) {
    const rejected = candidates.filter((path) => existsSync(path));
    throw new Error(
      `ptys: no ptys server for instance ${instance}; start one with \`ptys server start\`` +
      `${instance === DEFAULT_INSTANCE ? "" : ` --instance ${instance}`}, or pass --server for a remote one` +
      (rejected.length === 0
        ? ""
        : `\nptys: ignored ${rejected.join(", ")}: not a socket owned by you inside a private directory`),
    );
  }
  return { baseUrl: localBaseUrl(instance), socketPath };
}

export function resolveInstance(flagValue?: string): string {
  const value = flagValue ?? process.env.PTYS_INSTANCE;
  const instance = value === undefined || value.length === 0 ? DEFAULT_INSTANCE : value;
  validateInstanceName(instance);
  return instance;
}

function localBaseUrl(instance: string): string {
  return `http://${instance}.ptys.local`;
}
