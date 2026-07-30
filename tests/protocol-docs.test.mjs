import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import {
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  EventControlSchema,
  EventReplyControlSchema,
  OriginRequestSchema,
  PublishEventRequestSchema,
  ResizeControlSchema,
  SignalControlSchema,
  UpdateSessionRequestSchema,
  createAsyncApiDocument,
  createOpenApiDocument,
} from "@pty-server/protocol";

test("protocol request schemas preserve the public request contract", () => {
  assert.equal(Value.Check(CreateWorkspaceRequestSchema, { path: "/tmp", ignored: true }), true);
  assert.equal(Value.Check(CreateWorkspaceRequestSchema, { path: "" }), false);

  const validSession = {
    workspaceId: "workspace-1",
    cmd: "bash",
    args: ["-l"],
    env: { TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    futureField: "accepted",
  };
  assert.equal(Value.Check(CreateSessionRequestSchema, validSession), true);
  assert.equal(Value.Check(CreateSessionRequestSchema, { cols: 80, rows: 24 }), true);
  assert.equal(Value.Check(CreateSessionRequestSchema, { ...validSession, cmd: "" }), false);
  assert.equal(Value.Check(CreateSessionRequestSchema, { ...validSession, cols: 0 }), false);
  assert.equal(Value.Check(CreateSessionRequestSchema, { ...validSession, env: { TERM: 1 } }), false);
  assert.equal(Value.Check(UpdateSessionRequestSchema, { name: "editor", ignored: true }), true);
  assert.equal(Value.Check(UpdateSessionRequestSchema, { name: "" }), false);
  assert.equal(Value.Check(PublishEventRequestSchema, { type: "notification", data: { message: "done" } }), true);
  assert.equal(Value.Check(PublishEventRequestSchema, { type: "", data: {} }), false);
  assert.equal(Value.Check(OriginRequestSchema, { origin: "https://app.example", ignored: true }), true);
});

test("protocol WebSocket schemas distinguish the supported control frames", () => {
  assert.equal(Value.Check(ResizeControlSchema, { t: "resize", cols: 120, rows: 40 }), true);
  assert.equal(Value.Check(ResizeControlSchema, { t: "resize", cols: 0, rows: 40 }), false);
  assert.equal(Value.Check(SignalControlSchema, { t: "signal", sig: "SIGTERM" }), true);
  assert.equal(Value.Check(SignalControlSchema, { t: "signal", sig: "" }), false);
  assert.equal(Value.Check(EventReplyControlSchema, { t: "event.reply", requestId: "request", event: { type: "answer", data: true } }), true);
  assert.equal(Value.Check(EventControlSchema, { t: "event", event: { sessionId: "session", type: "notification", data: true } }), true);
  assert.equal(Value.Check(EventControlSchema, { t: "event", event: { sessionId: "session", type: "question", data: true }, requestId: "request", ttl: 30 }), true);
  assert.equal(Value.Check(EventControlSchema, { t: "event", event: { sessionId: "session", type: "question", data: true }, requestId: "request" }), false);
  assert.equal(Value.Check(EventControlSchema, { t: "event", event: { sessionId: "session", type: "notification", data: true }, ttl: 30 }), false);
});

test("generated documents cover public HTTP and terminal-stream operations only", () => {
  const openapi = createOpenApiDocument({ version: "0.1.0" });
  assert.equal(openapi.openapi, "3.1.0");
  assert.deepEqual(Object.keys(openapi.paths).sort(), [
    "/v1/config/origins",
    "/v1/directories",
    "/v1/events",
    "/v1/info",
    "/v1/sessions",
    "/v1/sessions/{id}",
    "/v1/sessions/{id}/exec",
    "/v1/sessions/{id}/signal",
    "/v1/workspaces",
  ]);

  const jsonSchema = (response) => response.content?.["application/json"]?.schema;
  for (const [path, operations] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (method === "parameters") continue;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status === "204") continue;
        assert.ok(jsonSchema(response), `${method.toUpperCase()} ${path} ${status} has no response schema`);
      }
    }
  }

  const events = openapi.paths["/v1/events"].post.responses;
  assert.deepEqual(jsonSchema(events["202"]), { $ref: "#/components/schemas/EventAccepted" });
  assert.equal(openapi.components.schemas.EventAccepted.properties.delivered.type, "integer");

  const origins = openapi.paths["/v1/config/origins"];
  const originsRef = { $ref: "#/components/schemas/OriginsResponse" };
  assert.deepEqual(jsonSchema(origins.get.responses["200"]), originsRef);
  assert.deepEqual(jsonSchema(origins.post.responses["201"]), originsRef);
  assert.deepEqual(jsonSchema(origins.post.responses["200"]), originsRef);
  assert.deepEqual(jsonSchema(origins.delete.responses["200"]), originsRef);

  const asyncapi = createAsyncApiDocument({ version: "0.1.0" });
  assert.equal(asyncapi.asyncapi, "3.1.0");
  assert.ok(asyncapi.channels.sessionAttach);
  assert.ok(asyncapi.channels.events);
  assert.equal(asyncapi.components.schemas.EventControl.anyOf[1].properties.ttl.minimum, 0);
  assert.equal(asyncapi.operations.receiveTerminalInput.action, "receive");
  assert.equal(asyncapi.operations.sendTerminalOutput.action, "send");
});
