import { Type, type Static } from "@sinclair/typebox";

const requestObjectOptions = { additionalProperties: true };

export const PROTOCOL_VERSION = 1;

export const PositiveIntegerSchema = Type.Integer({ minimum: 1 });

export const WorkspaceSchema = Type.Object({
  id: Type.String(),
  path: Type.String(),
  realpath: Type.String(),
  createdAt: Type.Number(),
}, { $id: "Workspace" });
export type Workspace = Static<typeof WorkspaceSchema>;

export const DirectoryEntrySchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
}, { $id: "DirectoryEntry" });
export type DirectoryEntry = Static<typeof DirectoryEntrySchema>;

export const DirectoryListingSchema = Type.Object({
  current: Type.Optional(DirectoryEntrySchema),
  breadcrumbs: Type.Array(DirectoryEntrySchema),
  entries: Type.Array(DirectoryEntrySchema),
  nextCursor: Type.Optional(Type.String()),
}, { $id: "DirectoryListing" });
export type DirectoryListing = Static<typeof DirectoryListingSchema>;

export const SessionExitedSchema = Type.Object({
  code: Type.Number(),
  signal: Type.Optional(Type.Number()),
  at: Type.Number(),
}, { $id: "SessionExited" });

export const StringRecordSchema = Type.Record(Type.String(), Type.String(), { $id: "StringRecord" });

export const SessionSchema = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  name: Type.Optional(Type.String()),
  cmd: Type.String(),
  args: Type.Array(Type.String()),
  env: StringRecordSchema,
  cols: PositiveIntegerSchema,
  rows: PositiveIntegerSchema,
  followSize: Type.Optional(Type.Boolean()),
  createdAt: Type.Number(),
  exited: Type.Optional(SessionExitedSchema),
}, { $id: "Session" });
export type Session = Static<typeof SessionSchema>;

export const ServerInfoSchema = Type.Object({
  version: Type.String(),
  protocol: Type.Integer(),
  serverId: Type.String(),
  uptime: Type.Number(),
  sessions: Type.Integer(),
  user: Type.String(),
  workspaces: Type.Integer(),
}, { $id: "ServerInfo" });
export type ServerInfo = Static<typeof ServerInfoSchema>;

export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
}, { $id: "ErrorResponse" });
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const CreateWorkspaceRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
}, { $id: "CreateWorkspaceRequest", ...requestObjectOptions });
export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequestSchema>;

export const CreateSessionRequestSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  cmd: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(StringRecordSchema),
  cols: PositiveIntegerSchema,
  rows: PositiveIntegerSchema,
  name: Type.Optional(Type.String()),
  followSize: Type.Optional(Type.Boolean()),
}, { $id: "CreateSessionRequest", ...requestObjectOptions });
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;

export const SignalSessionRequestSchema = Type.Object({
  signal: Type.String({ minLength: 1 }),
}, { $id: "SignalSessionRequest", ...requestObjectOptions });
export type SignalSessionRequest = Static<typeof SignalSessionRequestSchema>;

export const UpdateSessionRequestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
}, { $id: "UpdateSessionRequest", ...requestObjectOptions });
export type UpdateSessionRequest = Static<typeof UpdateSessionRequestSchema>;

export const OriginRequestSchema = Type.Object({
  origin: Type.String({ minLength: 1 }),
}, { $id: "OriginRequest", ...requestObjectOptions });
export type OriginRequest = Static<typeof OriginRequestSchema>;

export const OriginsResponseSchema = Type.Object({
  origins: Type.Array(Type.String()),
}, { $id: "OriginsResponse" });
export type OriginsResponse = Static<typeof OriginsResponseSchema>;

const ListenerProperties = {
  host: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
};

export const ListenerSchema = Type.Object(ListenerProperties, { $id: "Listener" });
export type Listener = Static<typeof ListenerSchema>;

export const AddListenerRequestSchema = Type.Object(ListenerProperties, { $id: "AddListenerRequest", ...requestObjectOptions });
export type AddListenerRequest = Static<typeof AddListenerRequestSchema>;

export const ListenersResponseSchema = Type.Object({
  listeners: Type.Array(ListenerSchema),
  token: Type.Optional(Type.String()),
}, { $id: "ListenersResponse" });
export type ListenersResponse = Static<typeof ListenersResponseSchema>;

export const EventInputSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
  data: Type.Unknown(),
}, { $id: "EventInput", ...requestObjectOptions });
export type EventInput = Static<typeof EventInputSchema>;

export const EventEnvelopeSchema = Type.Object({
  sessionId: Type.String(),
  type: Type.String({ minLength: 1 }),
  data: Type.Unknown(),
}, { $id: "EventEnvelope", ...requestObjectOptions });
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;

export const PublishEventRequestSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
  data: Type.Unknown(),
  request: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 300 })),
}, { $id: "PublishEventRequest", ...requestObjectOptions });
export type PublishEventRequest = Static<typeof PublishEventRequestSchema>;

export const EventAcceptedSchema = Type.Object({
  delivered: Type.Integer({ minimum: 0 }),
}, { $id: "EventAccepted" });
export type EventAccepted = Static<typeof EventAcceptedSchema>;

export const ResizeControlSchema = Type.Object({
  t: Type.Literal("resize"),
  cols: PositiveIntegerSchema,
  rows: PositiveIntegerSchema,
}, { $id: "ResizeControl", additionalProperties: true });
export type ResizeControl = Static<typeof ResizeControlSchema>;

export const SignalControlSchema = Type.Object({
  t: Type.Literal("signal"),
  sig: Type.String({ minLength: 1 }),
}, { $id: "SignalControl", additionalProperties: true });
export type SignalControl = Static<typeof SignalControlSchema>;

export const ClientControlMessageSchema = Type.Union([
  ResizeControlSchema,
  SignalControlSchema,
], { $id: "ClientControlMessage" });
export type ClientControlMessage = Static<typeof ClientControlMessageSchema>;

export const ReadyControlSchema = Type.Object({
  t: Type.Literal("ready"),
  protocol: Type.Integer(),
  sessionId: Type.String(),
  cols: PositiveIntegerSchema,
  rows: PositiveIntegerSchema,
}, { $id: "ReadyControl" });
export type ReadyControl = Static<typeof ReadyControlSchema>;

export const ResizedControlSchema = Type.Object({
  t: Type.Literal("resized"),
  cols: PositiveIntegerSchema,
  rows: PositiveIntegerSchema,
}, { $id: "ResizedControl" });
export type ResizedControl = Static<typeof ResizedControlSchema>;

export const ExitControlSchema = Type.Object({
  t: Type.Literal("exit"),
  code: Type.Number(),
  signal: Type.Optional(Type.Number()),
}, { $id: "ExitControl" });
export type ExitControl = Static<typeof ExitControlSchema>;

export const ErrorControlSchema = Type.Object({
  t: Type.Literal("error"),
  reason: Type.String(),
}, { $id: "ErrorControl" });
export type ErrorControl = Static<typeof ErrorControlSchema>;

export interface EventNotificationControl {
  t: "event";
  event: EventEnvelope;
  requestId?: never;
  ttl?: never;
}

export interface EventRequestControl {
  t: "event";
  event: EventEnvelope;
  requestId: string;
  ttl: number;
}

export type EventControl = EventNotificationControl | EventRequestControl;

const EventFrameSchema = Type.Object({
  t: Type.Literal("event"),
  event: EventEnvelopeSchema,
}, { additionalProperties: true });

const EventNotificationControlSchema = Type.Intersect([
  EventFrameSchema,
  Type.Not(Type.Object({ requestId: Type.Unknown() })),
  Type.Not(Type.Object({ ttl: Type.Unknown() })),
]);

const EventRequestControlSchema = Type.Object({
  t: Type.Literal("event"),
  event: EventEnvelopeSchema,
  requestId: Type.String({ minLength: 1 }),
  ttl: Type.Number({ minimum: 0, description: "Request lifetime in seconds; zero means no timeout." }),
}, { additionalProperties: true });

export const EventControlSchema = Type.Union([
  EventNotificationControlSchema,
  EventRequestControlSchema,
], { $id: "EventControl" });

export const EventReplyControlSchema = Type.Object({
  t: Type.Literal("event.reply"),
  requestId: Type.String({ minLength: 1 }),
  event: EventInputSchema,
}, {
  $id: "EventReplyControl",
  additionalProperties: true,
  description: "The reply event is correlated by requestId and does not include a sessionId.",
});
export type EventReplyControl = Static<typeof EventReplyControlSchema>;

export const ServerControlMessageSchema = Type.Union([
  ReadyControlSchema,
  ResizedControlSchema,
  ExitControlSchema,
  ErrorControlSchema,
], { $id: "ServerControlMessage" });
export type ServerControlMessage = Static<typeof ServerControlMessageSchema>;

export const EventStreamServerMessageSchema = Type.Union([
  EventControlSchema,
  ErrorControlSchema,
], { $id: "EventStreamServerMessage" });
export type EventStreamServerMessage = Static<typeof EventStreamServerMessageSchema>;
