# API documentation

`openapi.yaml` describes the ptys HTTP control plane. Load it in any OpenAPI 3.1-compatible Swagger UI to explore and try the REST operations.

`asyncapi.yaml` describes the session-attach WebSocket terminal stream, including JSON control frames and raw binary terminal data. Swagger UI does not render AsyncAPI; use an AsyncAPI-compatible viewer or generator for that file.

Both files are generated from the schemas in `@pty-server/protocol`. Run `npm run docs:generate` after changing a public contract, then commit the updated YAML. `npm run docs:check` verifies that the committed files are current and valid.
