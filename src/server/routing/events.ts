import { PublishEventRequestSchema } from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import { EventRequestTimeoutError, EventSessionEndedError, NoEventSubscriberError, type EventHub } from "../event-hub.js";
import type { SessionManager } from "../session-manager.js";
import { readJsonBody, registerRoute, sendError, sendJson, type HttpRouter } from "./utils.js";

export function registerEventRoutes(
  router: HttpRouter,
  dependencies: { eventHub: EventHub; sessionManager: SessionManager },
): void {
  registerRoute(router, "POST", "/v1/events", async ({ response, url, request }) => {
    const session = dependencies.sessionManager.getByEventToken(url.searchParams.get("token") ?? undefined);
    if (session === undefined) {
      sendError(response, 401, "unauthorized");
      return;
    }
    if (session.toJSON().exited !== undefined) {
      sendError(response, 409, "session exited");
      return;
    }
    const body = await readJsonBody(request);
    if (!Value.Check(PublishEventRequestSchema, body)) {
      sendError(response, 400, "event requires type and data");
      return;
    }
    if ("sessionId" in body) {
      sendError(response, 400, "sessionId is assigned by the server");
      return;
    }
    const event = { sessionId: session.id, type: body.type, data: body.data };
    if (!body.request) {
      sendJson(response, 202, { delivered: dependencies.eventHub.publish(event) });
      return;
    }
    try {
      const reply = await dependencies.eventHub.request(event, body.timeoutSeconds ?? 30);
      sendJson(response, 200, { event: reply });
    } catch (error) {
      if (error instanceof NoEventSubscriberError) sendError(response, 409, error.message);
      else if (error instanceof EventRequestTimeoutError) sendError(response, 504, error.message);
      else if (error instanceof EventSessionEndedError) sendError(response, 409, error.message);
      else throw error;
    }
  });
}
