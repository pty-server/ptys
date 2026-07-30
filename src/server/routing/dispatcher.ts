import type { IncomingMessage, ServerResponse } from "node:http";
import Router from "find-my-way";
import { extractBearerToken, verifyToken } from "../auth.js";
import type { DirectoryBrowser } from "../directory-browser.js";
import { EVENTS_PATH, type EventHub } from "../event-hub.js";
import type { ExecRunner } from "../exec.js";
import type { ListenerManager, PublicListenerFactory } from "../listener-manager.js";
import type { OriginAllowlist } from "../origin-allowlist.js";
import type { ListenAddress } from "../server-options.js";
import type { SessionManager } from "../session-manager.js";
import type { WorkspaceManager } from "../workspace-manager.js";
import { registerDaemonRoutes } from "./daemon.js";
import { registerDirectoryRoutes } from "./directories.js";
import { registerEventRoutes } from "./events.js";
import { registerInfoRoutes } from "./info.js";
import { registerListenerRoutes } from "./listeners.js";
import { registerOriginRoutes } from "./origins.js";
import { registerSessionRoutes } from "./sessions.js";
import {
  sendError,
  sendRouteError,
  type HttpRouter,
  type RequestContext,
} from "./utils.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

const CORS_ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS = "authorization, content-type";

/** Process-wide state, shared by every listener. */
export interface ServerServices {
  workspaceManager: WorkspaceManager;
  sessionManager: SessionManager;
  eventHub: EventHub;
  origins: OriginAllowlist;
  directoryBrowser: DirectoryBrowser;
  serverId: string;
  startedAt: number;
  defaultShell: string;
  capabilities: string[];
  exec?: ExecRunner;
}

/** Per-listener trust: how a caller on this transport is authenticated, and what it may reconfigure. */
export interface ListenerConfig {
  listeners: ListenerManager;
  trustedTransport: boolean;
  token?: string;
  createPublicListener?: PublicListenerFactory;
}

/** Returns true when the guard has answered the request and no route should run. */
type Guard = (context: RequestContext) => boolean;

export function createRequestHandler(services: ServerServices, listener: ListenerConfig) {
  const router = createRouter(services, listener);
  const guards: Guard[] = [
    createHostGuard(listener),
    createCorsGuard(services.origins),
    createAuthGuard(listener),
  ];

  return (request: IncomingMessage, response: ServerResponse): void => {
    try {
      const context = createRequestContext(request, response);
      if (context.pathname.startsWith("/v1/")) {
        for (const guard of guards) {
          if (guard(context)) return;
        }
      }
      router.lookup(request, response, context);
    } catch (error) {
      sendRouteError(response, error);
    }
  };
}

// A listener with no token has nothing to prove identity with, so it answers only requests addressed
// to an address it actually binds - otherwise a rebound DNS name reaches it from a browser.
function createHostGuard(listener: ListenerConfig): Guard {
  if (listener.trustedTransport || listener.token !== undefined) {
    return () => false;
  }
  return ({ request, response }) => {
    if (hasExpectedHost(request.headers.host, listener.listeners.list())) return false;
    sendError(response, 403, "host not allowed");
    return true;
  };
}

function createCorsGuard(origins: OriginAllowlist): Guard {
  return ({ request, response, method }) => {
    const origin = request.headers.origin;
    const allowed = origin !== undefined && origins.has(origin) ? origin : undefined;
    if (allowed !== undefined) {
      response.setHeader("Access-Control-Allow-Origin", allowed);
      response.setHeader("Vary", "Origin");
    }
    if (method !== "OPTIONS") return false;
    if (allowed !== undefined) {
      response.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
      response.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
    }
    response.writeHead(204);
    response.end();
    return true;
  };
}

function createAuthGuard(listener: ListenerConfig): Guard {
  const { token } = listener;
  if (token === undefined || listener.trustedTransport) {
    return () => false;
  }
  return ({ request, response, method, pathname }) => {
    // Event publishing carries the session's own event token in the query, verified by the route.
    if (method === "POST" && pathname === EVENTS_PATH) return false;
    if (verifyToken(extractBearerToken(request.headers.authorization), token)) return false;
    sendError(response, 401, "unauthorized");
    return true;
  };
}

function createRouter(services: ServerServices, listener: ListenerConfig): HttpRouter {
  const router = Router({
    caseSensitive: true,
    ignoreTrailingSlash: false,
    ignoreDuplicateSlashes: false,
    maxParamLength: Number.MAX_SAFE_INTEGER,
    defaultRoute: (_request, response) => sendError(response, 404, "not found"),
    onBadUrl: (_path, _request, response) => sendError(response, 404, "not found"),
  });

  if (listener.trustedTransport) {
    if (listener.createPublicListener === undefined) {
      throw new Error("trusted request handler requires a public listener factory");
    }
    registerDaemonRoutes(router, services);
    registerListenerRoutes(router, {
      listeners: listener.listeners,
      createPublicListener: listener.createPublicListener,
    });
  }

  registerInfoRoutes(router, services);
  registerOriginRoutes(router, services);
  registerEventRoutes(router, services);
  registerDirectoryRoutes(router, services);
  registerWorkspaceRoutes(router, services);
  registerSessionRoutes(router, services);
  return router;
}

function createRequestContext(request: IncomingMessage, response: ServerResponse): RequestContext {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return {
    request,
    response,
    url,
    method: request.method ?? "GET",
    pathname: url.pathname,
  };
}

function hasExpectedHost(presented: string | undefined, listen: ListenAddress[]): boolean {
  if (presented === undefined) return false;
  return listen.some(({ host, port }) => {
    const hostname = host.includes(":") ? `[${host}]` : host;
    return presented.toLowerCase() === `${hostname}:${port}`.toLowerCase();
  });
}
