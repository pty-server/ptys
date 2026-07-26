import { CreateWorkspaceRequestSchema } from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import { NotADirectoryError, type WorkspaceManager } from "../workspace-manager.js";
import { readJsonBody, registerRoute, sendError, sendJson, type HttpRouter } from "./utils.js";

export function registerWorkspaceRoutes(
  router: HttpRouter,
  dependencies: { workspaceManager: WorkspaceManager },
): void {
  const { workspaceManager } = dependencies;

  registerRoute(router, "POST", "/v1/workspaces", async ({ request, response }) => {
    const body = await readJsonBody(request);
    if (!Value.Check(CreateWorkspaceRequestSchema, body)) {
      sendError(response, 400, "path is required");
      return;
    }
    try {
      sendJson(response, 200, workspaceManager.create({ path: body.path }));
    } catch (error) {
      if (error instanceof NotADirectoryError) sendError(response, 400, error.message);
      else sendError(response, 400, "path does not exist");
    }
  });

  registerRoute(router, "GET", "/v1/workspaces", ({ response }) => {
    sendJson(response, 200, workspaceManager.list());
  });
}
