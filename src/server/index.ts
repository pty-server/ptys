import * as http from "node:http";
import type { Socket } from "node:net";
import { AttachRegistry } from "./ws/attach-registry.js";
import { createAttachUpgradeHandler } from "./ws/attach.js";
import { CONTROL_SOCKET_SUPPORTED, listenControlSocket, prepareControlSocketPath, type ControlSocket } from "./control-socket.js";
import { EVENTS_PATH, EventHub } from "./event-hub.js";
import { createEventsUpgradeHandler } from "./ws/events.js";
import { isLoopbackHost } from "./auth.js";
import { getOrCreateIdentity } from "./identity.js";
import { createRequestHandler, type ServerServices } from "./routing/dispatcher.js";
import { bridgeSessionEvents } from "./session-events.js";
import { SessionManager } from "./session-manager.js";
import { validateServerOptions, type ListenAddress } from "./server-options.js";
import { ListenerManager, type PublicListenerFactory } from "./listener-manager.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { DirectoryBrowser, canonicalizeBrowseRoots } from "./directory-browser.js";
import { DEFAULT_INSTANCE } from "../paths.js";
import { OriginAllowlist } from "./origin-allowlist.js";
import { closeHttpServer } from "./close-http-server.js";

export type { ListenAddress };

export interface StartServerOptions {
  instance?: string;
  listen?: ListenAddress[];
  token?: string;
  noAuth?: boolean;
  allowOrigins?: string[];
  scrollback?: number;
  browseRoots?: string[];
  maxClosedSessions?: number;
  onListenChange?: (listen: ListenAddress[]) => void;
}

export interface StartedServer {
  listeners: ListenerManager;
  serverId: string;
  controlSocketPath?: string;
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const listen = options.listen ?? [];
  const noAuth = options.noAuth ?? false;
  const scrollback = options.scrollback ?? 5000;
  const maxClosedSessions = options.maxClosedSessions;

  validateServerOptions({
    instance,
    listen,
    noAuth,
    allowOrigins: options.allowOrigins,
    scrollback,
    maxClosedSessions,
  });

  if (!CONTROL_SOCKET_SUPPORTED && listen.length === 0) {
    throw new Error("this platform has no control socket; pass --listen <host:port> to bind an address");
  }

  const origins = new OriginAllowlist(options.allowOrigins);
  const browseRoots = canonicalizeBrowseRoots(options.browseRoots);
  const { serverId } = getOrCreateIdentity();
  const startedAt = Date.now();
  const workspaceManager = new WorkspaceManager();
  const directoryBrowser = new DirectoryBrowser(browseRoots);
  const socketPath = CONTROL_SOCKET_SUPPORTED ? prepareControlSocketPath(instance) : undefined;
  const sessionManager = new SessionManager({ scrollback, maxClosedSessions, eventEndpoint: eventEndpoint(socketPath, listen) });
  const eventHub = new EventHub();
  const attachRegistry = new AttachRegistry();
  bridgeSessionEvents(sessionManager, eventHub);

  const services: ServerServices = {
    workspaceManager,
    sessionManager,
    serverId,
    startedAt,
    origins,
    directoryBrowser,
    eventHub,
  };

  const listeners = new ListenerManager({
    noAuth,
    token: options.token,
    initialListeners: listen.length,
    onChange: options.onListenChange,
  });

  const createListener = (
    trustedTransport: boolean,
    publicToken?: string,
    createPublicListener?: PublicListenerFactory,
  ): http.Server => {
    const listenerToken = trustedTransport ? undefined : publicToken;
    const listener = http.createServer(createRequestHandler(services, {
      listeners,
      trustedTransport,
      token: listenerToken,
      createPublicListener,
    }));
    const attachUpgrade = createAttachUpgradeHandler(sessionManager, {
      token: listenerToken,
      origins,
      registry: attachRegistry,
    });
    const eventsUpgrade = createEventsUpgradeHandler(eventHub, { token: listenerToken, origins });
    listener.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === EVENTS_PATH) eventsUpgrade(request, socket as Socket, head);
      else attachUpgrade(request, socket as Socket, head);
    });
    return listener;
  };

  const createPublicListener: PublicListenerFactory = (token) => createListener(false, token);

  let controlServer: http.Server | undefined;
  let controlSocket: ControlSocket | undefined;
  if (socketPath !== undefined) {
    controlServer = createListener(true, undefined, createPublicListener);
    controlSocket = await listenControlSocket(controlServer, socketPath);
  }

  const releaseTransports = async (): Promise<void> => {
    await listeners.closeAll();
    if (controlServer !== undefined) {
      await closeHttpServer(controlServer);
    }
    // Released last, and only while the pathname still names this process's socket: by now a successor
    // may already have taken the instance over.
    controlSocket?.release();
  };

  try {
    await listeners.bindInitial(listen, createPublicListener);
  } catch (error) {
    await releaseTransports();
    throw error;
  }

  return {
    listeners,
    serverId,
    ...(socketPath === undefined ? {} : { controlSocketPath: socketPath }),
    close: async () => {
      sessionManager.shutdown();
      eventHub.close();
      await releaseTransports();
    },
  };
}

function eventEndpoint(socketPath: string | undefined, listen: ListenAddress[]): string | undefined {
  if (socketPath !== undefined) {
    return `http+unix:${socketPath}:${EVENTS_PATH}`;
  }
  const address = listen.find((candidate) => isLoopbackHost(candidate.host)) ?? listen[0];
  if (address === undefined) {
    return undefined;
  }
  const host = address.host === "0.0.0.0" ? "127.0.0.1" : address.host === "::" ? "[::1]" : address.host;
  return `http://${host}:${address.port}${EVENTS_PATH}`;
}
