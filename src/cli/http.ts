import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ServerTarget } from "./target.js";

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function sendRequest(target: ServerTarget, path: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
  const url = new URL(`${target.baseUrl}${path}`);
  const secure = url.protocol === "https:";
  const headers = { ...init.headers };
  if (init.body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(init.body));
  }

  const options: RequestOptions = target.socketPath === undefined
    ? {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
    }
    : {
      socketPath: target.socketPath,
      headers: { ...headers, host: url.host },
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
    };

  return new Promise<HttpResponse>((resolve, reject) => {
    const send = secure && target.socketPath === undefined ? httpsRequest : httpRequest;
    const request = send(options, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        body,
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (init.body !== undefined) {
      request.write(init.body);
    }
    request.end();
  });
}

export function parseEndpoint(value: string): ServerTarget & { path: string } {
  const unixPrefix = "http+unix:";
  if (!value.startsWith(unixPrefix)) {
    const url = new URL(value);
    return { baseUrl: url.origin, path: `${url.pathname}${url.search}` };
  }
  const rest = value.slice(unixPrefix.length);
  const separator = rest.lastIndexOf(":/");
  if (separator < 0) {
    throw new Error(`invalid endpoint ${value}`);
  }
  return {
    baseUrl: "http://localhost",
    socketPath: rest.slice(0, separator),
    path: rest.slice(separator + 1),
  };
}

export function describeTarget(target: ServerTarget): string {
  return target.socketPath === undefined ? target.baseUrl : target.socketPath;
}
