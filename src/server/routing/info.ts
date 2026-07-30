import { userInfo } from "node:os";
import { PROTOCOL_VERSION, type ServerInfo } from "@pty-server/protocol";
import { VERSION } from "../../version.js";
import type { SessionManager } from "../session-manager.js";
import type { WorkspaceManager } from "../workspace-manager.js";
import { registerRoute, sendJson, type HttpRouter } from "./utils.js";

export function registerInfoRoutes(
  router: HttpRouter,
  dependencies: {
    serverId: string;
    startedAt: number;
    sessionManager: SessionManager;
    workspaceManager: WorkspaceManager;
    capabilities: string[];
  },
): void {
  registerRoute(router, "GET", "/v1/info", ({ response }) => {
    const info: ServerInfo = {
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      serverId: dependencies.serverId,
      uptime: Date.now() - dependencies.startedAt,
      sessions: dependencies.sessionManager.list().length,
      user: userInfo().username,
      workspaces: dependencies.workspaceManager.list().length,
      capabilities: dependencies.capabilities,
    };
    sendJson(response, 200, info);
  });
}
