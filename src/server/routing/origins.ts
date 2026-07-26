import { OriginRequestSchema } from "@pty-server/protocol";
import { Value } from "@sinclair/typebox/value";
import { isValidOrigin, type OriginAllowlist } from "../origin-allowlist.js";
import { readJsonBody, registerRoute, sendError, sendJson, type HttpRouter } from "./utils.js";

export function registerOriginRoutes(router: HttpRouter, dependencies: { origins: OriginAllowlist }): void {
  const { origins } = dependencies;

  registerRoute(router, "GET", "/v1/config/origins", ({ response }) => {
    sendJson(response, 200, { origins: origins.list() });
  });

  registerRoute(router, "POST", "/v1/config/origins", async ({ request, response }) => {
    const body = await readJsonBody(request);
    if (!Value.Check(OriginRequestSchema, body) || !isValidOrigin(body.origin)) {
      sendError(response, 400, "origin must be an absolute http(s) origin without a path");
      return;
    }
    const added = origins.add(body.origin);
    sendJson(response, added ? 201 : 200, { origins: origins.list() });
  });

  registerRoute(router, "DELETE", "/v1/config/origins", ({ response, url }) => {
    const origin = url.searchParams.get("origin");
    if (origin === null || !isValidOrigin(origin)) {
      sendError(response, 400, "origin must be an absolute http(s) origin without a path");
      return;
    }
    if (!origins.remove(origin)) {
      sendError(response, 404, "origin not found");
      return;
    }
    sendJson(response, 200, { origins: origins.list() });
  });
}
