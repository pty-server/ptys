import {
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  DirectoryListingSchema,
  EventAcceptedSchema,
  EventInputSchema,
  ErrorResponseSchema,
  ExecSessionRequestSchema,
  ExecSessionResponseSchema,
  OriginRequestSchema,
  OriginsResponseSchema,
  PublishEventRequestSchema,
  ServerInfoSchema,
  SessionSchema,
  SignalSessionRequestSchema,
  UpdateSessionRequestSchema,
  WorkspaceSchema,
} from "./schemas.js";

export interface ApiDocumentOptions {
  version: string;
}

type Document = Record<string, unknown>;

const json = (schema: unknown): Document => ({
  content: { "application/json": { schema } },
});

const ref = (name: string): Document => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = (description: string): Document => ({
  description,
  ...json(ref("ErrorResponse")),
});

const responses = (success: Record<string, unknown>, errors: Record<string, string>): Document => ({
  ...success,
  ...Object.fromEntries(Object.entries(errors).map(([status, description]) => [status, errorResponse(description)])),
});

const authenticated = [{ bearerAuth: [] }];

export function createOpenApiDocument({ version }: ApiDocumentOptions): Document {
  const commonErrors = { "401": "Missing or invalid bearer token", "500": "Internal server error" };
  return {
    openapi: "3.1.0",
    info: {
      title: "ptys HTTP API",
      version,
      description: "HTTP control plane for ptys sessions. The terminal stream is documented separately in AsyncAPI.",
      license: { name: "MIT", url: "https://opensource.org/license/mit" },
    },
    servers: [{ url: "/", description: "The ptys server being addressed" }],
    tags: [
      { name: "Server", description: "Server metadata" },
      { name: "Directories", description: "Browsable workspace directories" },
      { name: "Workspaces", description: "Workspace lifecycle" },
      { name: "Sessions", description: "Terminal session lifecycle" },
      { name: "Events", description: "In-session event emission" },
      { name: "Origins", description: "Browser origin allowlist" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Required unless the server was started with --no-auth." },
        eventCapability: { type: "apiKey", in: "query", name: "token", description: "Per-session capability injected through PTYS_EVENT_ENDPOINT." },
      },
      schemas: {
        Workspace: WorkspaceSchema,
        DirectoryListing: DirectoryListingSchema,
        Session: SessionSchema,
        ServerInfo: ServerInfoSchema,
        ErrorResponse: ErrorResponseSchema,
        CreateWorkspaceRequest: CreateWorkspaceRequestSchema,
        CreateSessionRequest: CreateSessionRequestSchema,
        SignalSessionRequest: SignalSessionRequestSchema,
        UpdateSessionRequest: UpdateSessionRequestSchema,
        ExecSessionRequest: ExecSessionRequestSchema,
        ExecSessionResponse: ExecSessionResponseSchema,
        EventInput: EventInputSchema,
        PublishEventRequest: PublishEventRequestSchema,
        EventAccepted: EventAcceptedSchema,
        OriginRequest: OriginRequestSchema,
        OriginsResponse: OriginsResponseSchema,
      },
    },
    paths: {
      "/v1/info": {
        get: {
          tags: ["Server"],
          operationId: "getServerInfo",
          summary: "Get server metadata",
          security: authenticated,
          responses: responses({ "200": { description: "Server metadata", ...json(ref("ServerInfo")) } }, commonErrors),
        },
      },
      "/v1/events": {
        post: {
          tags: ["Events"],
          operationId: "publishSessionEvent",
          summary: "Publish an event from a session",
          description: "Requires the per-session event capability injected as the `token` query parameter in `PTYS_EVENT_ENDPOINT`.",
          security: [{ eventCapability: [] }],
          parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" }, description: "Session event capability" }],
          requestBody: { required: true, ...json(ref("PublishEventRequest")) },
          responses: responses({
            "202": { description: "Event accepted", ...json(ref("EventAccepted")) },
            "200": { description: "Request reply", ...json({ type: "object", required: ["event"], properties: { event: ref("EventInput") } }) },
          }, { "400": "Invalid event", "401": "Invalid event capability", "409": "No event subscriber or session exited", "504": "Event request timed out", "500": "Internal server error" }),
        },
      },
      "/v1/config/origins": {
        get: {
          tags: ["Origins"],
          operationId: "listAllowedOrigins",
          summary: "List allowed browser origins",
          security: authenticated,
          responses: responses({ "200": { description: "Allowed origins", ...json(ref("OriginsResponse")) } }, commonErrors),
        },
        post: {
          tags: ["Origins"],
          operationId: "allowOrigin",
          summary: "Allow a browser origin immediately",
          description: "Changes are in-memory only and are lost when the server stops.",
          security: authenticated,
          requestBody: { required: true, ...json(ref("OriginRequest")) },
          responses: responses({
            "201": { description: "Origin allowed", ...json(ref("OriginsResponse")) },
            "200": { description: "Origin was already allowed", ...json(ref("OriginsResponse")) },
          }, { ...commonErrors, "400": "Invalid origin" }),
        },
        delete: {
          tags: ["Origins"],
          operationId: "removeOrigin",
          summary: "Remove a browser origin immediately",
          description: "Changes are in-memory only and are lost when the server stops.",
          security: authenticated,
          parameters: [{ name: "origin", in: "query", required: true, schema: { type: "string" } }],
          responses: responses({ "200": { description: "Origin removed", ...json(ref("OriginsResponse")) } }, { ...commonErrors, "400": "Invalid origin", "404": "Origin not found" }),
        },
      },
      "/v1/directories": {
        get: {
          tags: ["Directories"],
          operationId: "listDirectories",
          summary: "List accessible directories",
          security: authenticated,
          parameters: [
            { name: "path", in: "query", required: false, schema: { type: "string" }, description: "Directory to list; omitted to list browse roots." },
            { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Case-insensitive directory-name filter." },
            { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque pagination cursor returned by a prior response." },
          ],
          responses: responses({ "200": { description: "Directory listing", ...json(ref("DirectoryListing")) } }, { ...commonErrors, "400": "Directory is unavailable or the query is invalid" }),
        },
      },
      "/v1/workspaces": {
        get: {
          tags: ["Workspaces"],
          operationId: "listWorkspaces",
          summary: "List workspaces",
          security: authenticated,
          responses: responses({ "200": { description: "Workspaces", ...json({ type: "array", items: ref("Workspace") }) } }, commonErrors),
        },
        post: {
          tags: ["Workspaces"],
          operationId: "createWorkspace",
          summary: "Create or retrieve a workspace for a local path",
          security: authenticated,
          requestBody: { required: true, ...json(ref("CreateWorkspaceRequest")) },
          responses: responses({ "200": { description: "Workspace", ...json(ref("Workspace")) } }, { ...commonErrors, "400": "Path is missing, does not exist, or is not a directory" }),
        },
      },
      "/v1/sessions": {
        get: {
          tags: ["Sessions"],
          operationId: "listSessions",
          summary: "List sessions",
          security: authenticated,
          parameters: [{ name: "workspaceId", in: "query", required: false, schema: { type: "string" } }],
          responses: responses({ "200": { description: "Sessions", ...json({ type: "array", items: ref("Session") }) } }, commonErrors),
        },
        post: {
          tags: ["Sessions"],
          operationId: "createSession",
          summary: "Create a terminal session",
          description: "When omitted, `cmd` defaults to the server user's shell. `workspaceId` defaults to a workspace rooted at the server working directory.",
          security: authenticated,
          requestBody: { required: true, ...json(ref("CreateSessionRequest")) },
          responses: responses({ "200": { description: "Session", ...json(ref("Session")) } }, { ...commonErrors, "400": "Invalid session request", "404": "Workspace not found" }),
        },
      },
      "/v1/sessions/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session identifier" }],
        get: {
          tags: ["Sessions"],
          operationId: "getSession",
          summary: "Get a session",
          security: authenticated,
          responses: responses({ "200": { description: "Session", ...json(ref("Session")) } }, { ...commonErrors, "404": "Session not found" }),
        },
        patch: {
          tags: ["Sessions"],
          operationId: "updateSession",
          summary: "Update a session name",
          security: authenticated,
          requestBody: { required: true, ...json(ref("UpdateSessionRequest")) },
          responses: responses({ "200": { description: "Updated session", ...json(ref("Session")) } }, { ...commonErrors, "400": "Name is missing", "404": "Session not found" }),
        },
        delete: {
          tags: ["Sessions"],
          operationId: "deleteSession",
          summary: "Stop a running session or remove an exited session",
          description: "A running session receives the requested signal. An exited session is removed from retained history immediately.",
          security: authenticated,
          parameters: [{ name: "signal", in: "query", required: false, schema: { type: "string", default: "SIGTERM" } }],
          responses: responses({ "204": { description: "Session stopped or removed" } }, { ...commonErrors, "404": "Session not found" }),
        },
      },
      "/v1/sessions/{id}/signal": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session identifier" }],
        post: {
          tags: ["Sessions"],
          operationId: "signalSession",
          summary: "Send a signal to a session",
          security: authenticated,
          requestBody: { required: true, ...json(ref("SignalSessionRequest")) },
          responses: responses({ "204": { description: "Signal sent" } }, { ...commonErrors, "400": "Signal is missing", "404": "Session not found" }),
        },
      },
      "/v1/sessions/{id}/exec": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session identifier" }],
        post: {
          tags: ["Sessions"],
          operationId: "execInSession",
          summary: "Run a one-shot command in a session's context",
          description: [
            "Runs `cmd` with `args` as discrete arguments - no shell is involved - in the session's environment, and buffers the output.",
            "A command that cannot be spawned at all, such as a missing binary, is reported as `200` with `code: null` and the reason in `stderr`, so a client can tell a missing tool from a broken endpoint.",
            "A command that exceeds the output cap or the timeout is signalled rather than left running, so `truncated` or `timedOut` arrives with the signal that stopped it instead of an exit status.",
            "The whole route is absent, answering `404`, on a server started with `--disable-exec`; `GET /v1/info` advertises `exec` in `capabilities` when it is available.",
          ].join(" "),
          security: authenticated,
          requestBody: { required: true, ...json(ref("ExecSessionRequest")) },
          responses: responses({ "200": { description: "Command result", ...json(ref("ExecSessionResponse")) } }, {
            ...commonErrors,
            "400": "Command is missing or the request is invalid",
            "404": "Session not found, or exec is disabled on this server",
            "409": "Session has exited",
            "429": "Too many concurrent commands",
          }),
        },
      },
    },
  };
}
