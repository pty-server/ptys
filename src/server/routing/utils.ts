import type { IncomingMessage, ServerResponse } from "node:http";
import type Router from "find-my-way";
import type { TSchema } from "@sinclair/typebox";
import { ValueErrorType } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
}

export type RouteParams = { [key: string]: string | undefined };
export type HttpRouter = Router.Instance<Router.HTTPVersion.V1>;

/** Names of the `:name` segments in a route path, so handlers see them as required strings. */
export type PathParams<Path extends string> = Path extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}` ? Name | PathParams<Tail> : Rest
  : never;

export type RouteHandler<Path extends string> = (
  context: RequestContext,
  params: Record<PathParams<Path>, string>,
) => void | Promise<void>;

interface JsonObject {
  [key: string]: unknown;
}

export class EmptyBodyError extends Error {}
export class UnsupportedMediaTypeError extends Error {}
export class PayloadTooLargeError extends Error {}

export async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new UnsupportedMediaTypeError();
  }
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > MAX_JSON_BODY_BYTES) {
    request.resume();
    throw new PayloadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= MAX_JSON_BODY_BYTES) chunks.push(buffer);
  }
  if (size > MAX_JSON_BODY_BYTES) throw new PayloadTooLargeError();
  if (chunks.length === 0) throw new EmptyBodyError();
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("JSON body must be an object");
  }
  return parsed as JsonObject;
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export function sendEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode);
  response.end();
}

export function sendError(response: ServerResponse, statusCode: number, error: string): void {
  sendJson(response, statusCode, { error });
}

export function describeInvalidBody(schema: TSchema, body: unknown, fallback: string): string {
  const [first] = Value.Errors(schema, body);
  const property = first === undefined ? undefined : first.path.split("/")[1];
  if (property === undefined || property.length === 0) return fallback;
  return first?.type === ValueErrorType.ObjectRequiredProperty ? `${property} is required` : `${property} is invalid`;
}

export function sendRouteError(response: ServerResponse, error: unknown): void {
  if (error instanceof SyntaxError || error instanceof EmptyBodyError) {
    sendError(response, 400, "invalid JSON body");
  } else if (error instanceof UnsupportedMediaTypeError) {
    sendError(response, 415, "Content-Type must be application/json");
  } else if (error instanceof PayloadTooLargeError) {
    sendError(response, 413, "JSON body exceeds 64 KiB");
  } else {
    // The response says nothing useful on purpose, so the daemon log is the only place the cause survives.
    console.error("ptys: unhandled request error:", error);
    sendError(response, 500, "internal server error");
  }
}

export function registerRoute<Path extends string>(
  router: HttpRouter,
  method: Router.HTTPMethod,
  path: Path,
  handler: RouteHandler<Path>,
): void {
  router.on(method, path, function routeAdapter(
    this: RequestContext,
    _request: IncomingMessage,
    _response: ServerResponse,
    params: RouteParams,
  ): void {
    // Empty params are the router's business, not each handler's: reject them once, here.
    if (Object.values(params).some((param) => param === undefined || param.length === 0)) {
      sendError(this.response, 404, "not found");
      return;
    }
    void Promise.resolve()
      .then(() => handler(this, params as Record<PathParams<Path>, string>))
      .catch((error: unknown) => sendRouteError(this.response, error));
  });
}
