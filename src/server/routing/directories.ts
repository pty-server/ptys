import { DirectoryUnavailableError, type DirectoryBrowser } from "../directory-browser.js";
import { registerRoute, sendError, sendJson, type HttpRouter } from "./utils.js";

export function registerDirectoryRoutes(
  router: HttpRouter,
  dependencies: { directoryBrowser: DirectoryBrowser },
): void {
  const { directoryBrowser } = dependencies;

  registerRoute(router, "GET", "/v1/directories", ({ response, url }) => {
    try {
      sendJson(response, 200, directoryBrowser.list(
        url.searchParams.get("path") ?? undefined,
        url.searchParams.get("q") ?? undefined,
        url.searchParams.get("cursor") ?? undefined,
      ));
    } catch (error) {
      if (error instanceof DirectoryUnavailableError) sendError(response, 400, "directory unavailable");
      else throw error;
    }
  });
}
