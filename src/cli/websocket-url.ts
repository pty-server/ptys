import type { ServerTarget } from "./target.js";

export function webSocketUrl(target: ServerTarget, path: string, params?: URLSearchParams): string {
  const query = params === undefined || params.size === 0 ? "" : `?${params}`;
  if (target.socketPath !== undefined) {
    return `ws+unix:${target.socketPath}:${path}${query}`;
  }
  const url = new URL(`${path}${query}`, target.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function webSocketHeaders(target: ServerTarget): { headers: Record<string, string> } | undefined {
  return target.token === undefined ? undefined : { headers: { Authorization: `Bearer ${target.token}` } };
}
