import type * as http from "node:http";

export function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeIdleConnections();
    server.close(() => resolve());
  });
}
