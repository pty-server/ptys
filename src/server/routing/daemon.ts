import { registerRoute, sendJson, type HttpRouter } from "./utils.js";

export function registerDaemonRoutes(
  router: HttpRouter,
  dependencies: { serverId: string; startedAt: number },
): void {
  registerRoute(router, "GET", "/v1/daemon", ({ response }) => {
    sendJson(response, 200, { pid: process.pid, serverId: dependencies.serverId, startedAt: dependencies.startedAt });
  });
}
