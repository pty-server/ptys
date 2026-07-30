import { CreateSessionRequestSchema, ExecSessionRequestSchema, SignalSessionRequestSchema, UpdateSessionRequestSchema } from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import type { EventHub } from "../event-hub.js";
import { ExecBusyError, type ExecRunner } from "../exec.js";
import { resolveLiveCwd } from "../proc-cwd.js";
import type { SessionManager } from "../session-manager.js";
import type { WorkspaceManager } from "../workspace-manager.js";
import { describeInvalidBody, readJsonBody, registerRoute, sendEmpty, sendError, sendJson, type HttpRouter } from "./utils.js";

export function registerSessionRoutes(
  router: HttpRouter,
  dependencies: {
    sessionManager: SessionManager;
    workspaceManager: WorkspaceManager;
    eventHub: EventHub;
    defaultShell: string;
    exec?: ExecRunner;
  },
): void {
  registerRoute(router, "POST", "/v1/sessions", async ({ request, response }) => {
    const body = await readJsonBody(request);
    if (!Value.Check(CreateSessionRequestSchema, body)) {
      sendError(response, 400, describeInvalidBody(CreateSessionRequestSchema, body, "cols and rows are required"));
      return;
    }
    const workspace = body.workspaceId === undefined
      ? dependencies.workspaceManager.getOrCreateDefault()
      : dependencies.workspaceManager.get(body.workspaceId);
    if (workspace === undefined) {
      sendError(response, 404, "workspace not found");
      return;
    }
    const session = dependencies.sessionManager.create({
      workspaceId: workspace.id,
      cwd: workspace.realpath,
      cmd: body.cmd ?? dependencies.defaultShell,
      args: body.args,
      env: body.env,
      cols: body.cols,
      rows: body.rows,
      name: body.name,
      followSize: body.followSize,
    });
    sendJson(response, 200, session.toJSON());
  });

  registerRoute(router, "GET", "/v1/sessions", ({ response, url }) => {
    const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
    sendJson(response, 200, dependencies.sessionManager.list({ workspaceId }).map((session) => session.toJSON()));
  });

  registerRoute(router, "GET", "/v1/sessions/:id", ({ response }, { id }) => {
    const session = dependencies.sessionManager.get(id);
    if (session === undefined) sendError(response, 404, "session not found");
    else sendJson(response, 200, session.toJSON());
  });

  registerRoute(router, "PATCH", "/v1/sessions/:id", async ({ request, response }, { id }) => {
    const body = await readJsonBody(request);
    if (!Value.Check(UpdateSessionRequestSchema, body)) {
      sendError(response, 400, describeInvalidBody(UpdateSessionRequestSchema, body, "name is required"));
      return;
    }
    const session = dependencies.sessionManager.rename(id, body.name);
    if (session === undefined) {
      sendError(response, 404, "session not found");
    } else {
      sendJson(response, 200, session.toJSON());
      dependencies.eventHub.publish({ sessionId: session.id, type: "session.updated", data: { name: body.name } });
    }
  });

  registerRoute(router, "DELETE", "/v1/sessions/:id", ({ response, url }, { id }) => {
    if (dependencies.sessionManager.delete(id, url.searchParams.get("signal") ?? "SIGTERM")) sendEmpty(response, 204);
    else sendError(response, 404, "session not found");
  });

  registerRoute(router, "POST", "/v1/sessions/:id/signal", async ({ request, response }, { id }) => {
    const body = await readJsonBody(request);
    if (!Value.Check(SignalSessionRequestSchema, body)) {
      sendError(response, 400, describeInvalidBody(SignalSessionRequestSchema, body, "signal is required"));
      return;
    }
    if (dependencies.sessionManager.signal(id, body.signal)) sendEmpty(response, 204);
    else sendError(response, 404, "session not found");
  });

  const exec = dependencies.exec;
  if (exec !== undefined) {
    registerRoute(router, "POST", "/v1/sessions/:id/exec", async ({ request, response }, { id }) => {
      const body = await readJsonBody(request);
      if (!Value.Check(ExecSessionRequestSchema, body)) {
        sendError(response, 400, describeInvalidBody(ExecSessionRequestSchema, body, "cmd is required"));
        return;
      }
      const session = dependencies.sessionManager.get(id);
      if (session === undefined) {
        sendError(response, 404, "session not found");
        return;
      }
      if (session.exited !== undefined) {
        sendError(response, 409, "session has exited");
        return;
      }
      const cwd = body.cwd === "live" ? await resolveLiveCwd(session.pid, session.cwd) : session.cwd;
      try {
        sendJson(response, 200, await exec.run(session.id, {
          cmd: body.cmd,
          args: body.args,
          cwd,
          env: session.environment,
          stdin: body.stdin,
          timeoutMs: body.timeoutMs,
        }));
      } catch (error) {
        if (!(error instanceof ExecBusyError)) throw error;
        sendError(response, 429, error.message);
      }
    });
  }
}
