# @pty-server/protocol

Shared wire protocol for [ptys](https://github.com/pty-server/ptys): TypeScript types, TypeBox JSON schemas, the protocol version, and generated API-document builders.

## Install

```sh
npm install @pty-server/protocol
```

## Exports

```ts
import {
  PROTOCOL_VERSION,
  SessionSchema,
  type Session,
  createOpenApiDocument,
  createAsyncApiDocument,
} from "@pty-server/protocol";
```

- `*Schema` exports are [TypeBox](https://github.com/sinclairzx81/typebox) schemas for HTTP and WebSocket payloads.
- The matching TypeScript types are exported alongside their schemas.
- `PROTOCOL_VERSION` identifies the terminal-stream protocol version.
- `createOpenApiDocument` and `createAsyncApiDocument` generate the HTTP and WebSocket API documents used by ptys.

See the repository’s [HTTP API](https://github.com/pty-server/ptys/blob/main/docs/openapi.yaml) and [terminal-stream API](https://github.com/pty-server/ptys/blob/main/docs/asyncapi.yaml) documents for endpoint details.
