import type { IncomingMessage } from "node:http";
import { AddListenerRequestSchema } from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import { AddressInUseError, type ListenerManager, type PublicListenerFactory } from "../listener-manager.js";
import type { ListenAddress } from "../server-options.js";
import { readJsonBody, registerRoute, sendError, sendJson, type HttpRouter } from "./utils.js";

export function registerListenerRoutes(
  router: HttpRouter,
  dependencies: { listeners: ListenerManager; createPublicListener: PublicListenerFactory },
): void {
  registerRoute(router, "GET", "/v1/config/listeners", ({ response }) => {
    sendJson(response, 200, { listeners: dependencies.listeners.list() });
  });

  registerRoute(router, "POST", "/v1/config/listeners", async ({ request, response }) => {
    const body = await readJsonBody(request);
    if (!Value.Check(AddListenerRequestSchema, body)) {
      sendError(response, 400, "listener requires a non-empty host and a port from 1 to 65535");
      return;
    }
    const address = { host: body.host, port: body.port };
    try {
      const token = await dependencies.listeners.add(address, dependencies.createPublicListener);
      sendJson(response, 201, { listeners: dependencies.listeners.list(), ...(token === undefined ? {} : { token }) });
    } catch (error) {
      if (error instanceof AddressInUseError) {
        sendError(response, 409, error.message);
      } else {
        sendError(response, 400, error instanceof Error ? error.message : "cannot listen on that address");
      }
    }
  });

  registerRoute(router, "DELETE", "/v1/config/listeners", async ({ request, response, url }) => {
    const address = listenerFromQuery(url.searchParams);
    if (address === undefined) {
      sendError(response, 400, "host and port query parameters are required");
      return;
    }
    if (servesThisRequest(request, address)) {
      sendError(response, 409, "refusing to close the listener serving this request");
      return;
    }
    if (!await dependencies.listeners.remove(address)) {
      sendError(response, 404, "listener not found");
      return;
    }
    sendJson(response, 200, { listeners: dependencies.listeners.list() });
  });
}

function listenerFromQuery(params: URLSearchParams): ListenAddress | undefined {
  const host = params.get("host");
  const port = Number(params.get("port"));
  if (host === null || host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host, port };
}

function servesThisRequest(request: IncomingMessage, address: ListenAddress): boolean {
  const { localAddress, localPort } = request.socket;
  if (localPort !== address.port || localAddress === undefined) return false;
  if (address.host === "0.0.0.0" || address.host === "::") return true;
  const unmapped = localAddress.replace(/^::ffff:/, "");
  return unmapped === address.host || localAddress === address.host;
}
