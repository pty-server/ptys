import type { DirectoryListing, ExecSessionRequest, ExecSessionResponse, Listener, ListenersResponse, ServerInfo, Session, Workspace } from "@pty-server/protocol";
import { describeTarget, sendRequest } from "./http.js";
import type { ServerTarget } from "./target.js";

export interface CreateSessionInput {
  workspaceId?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  name?: string;
  followSize?: boolean;
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? `: ${parsed.error}` : "";
  } catch {
    return "";
  }
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly detail?: string,
  ) {
    super(`${status} ${statusText}${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "HttpStatusError";
  }
}

export class ApiClient {
  constructor(private readonly target: ServerTarget) {}

  async getServerInfo(): Promise<ServerInfo> {
    return this.request<ServerInfo>("/v1/info");
  }

  async listOrigins(): Promise<string[]> {
    const response = await this.request<{ origins: string[] }>("/v1/config/origins");
    return response.origins;
  }

  async allowOrigin(origin: string): Promise<string[]> {
    const response = await this.request<{ origins: string[] }>("/v1/config/origins", { method: "POST", body: { origin } });
    return response.origins;
  }

  async removeOrigin(origin: string): Promise<string[]> {
    const response = await this.request<{ origins: string[] }>(`/v1/config/origins?origin=${encodeURIComponent(origin)}`, { method: "DELETE" });
    return response.origins;
  }

  async listListeners(): Promise<Listener[]> {
    const response = await this.request<ListenersResponse>("/v1/config/listeners");
    return response.listeners;
  }

  async addListener(address: Listener): Promise<ListenersResponse> {
    return this.request<ListenersResponse>("/v1/config/listeners", { method: "POST", body: address });
  }

  async removeListener(address: Listener): Promise<Listener[]> {
    const query = new URLSearchParams({ host: address.host, port: String(address.port) });
    const response = await this.request<ListenersResponse>(`/v1/config/listeners?${query}`, { method: "DELETE" });
    return response.listeners;
  }

  async createWorkspace(path: string): Promise<Workspace> {
    return this.request<Workspace>("/v1/workspaces", {
      method: "POST",
      body: { path },
    });
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>("/v1/workspaces");
  }

  async listDirectories(path?: string, q?: string, cursor?: string): Promise<DirectoryListing> {
    const params = new URLSearchParams();
    if (path !== undefined) params.set("path", path);
    if (q !== undefined) params.set("q", q);
    if (cursor !== undefined) params.set("cursor", cursor);
    return this.request<DirectoryListing>(`/v1/directories${params.size === 0 ? "" : `?${params}`}`);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.request<Session>("/v1/sessions", {
      method: "POST",
      body: input,
    });
  }

  async listSessions(workspaceId?: string): Promise<Session[]> {
    const query = workspaceId
      ? `?workspaceId=${encodeURIComponent(workspaceId)}`
      : "";
    return this.request<Session[]>(`/v1/sessions${query}`);
  }

  async getSession(id: string): Promise<Session> {
    return this.request<Session>(`/v1/sessions/${encodeURIComponent(id)}`);
  }

  async renameSession(id: string, name: string): Promise<Session> {
    return this.request<Session>(`/v1/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name },
    });
  }

  async killSession(id: string, signal?: string): Promise<void> {
    const query = signal ? `?signal=${encodeURIComponent(signal)}` : "";
    await this.request<void>(`/v1/sessions/${encodeURIComponent(id)}${query}`, {
      method: "DELETE",
    });
  }

  async signalSession(id: string, signal: string): Promise<void> {
    await this.request<void>(`/v1/sessions/${encodeURIComponent(id)}/signal`, {
      method: "POST",
      body: { signal },
    });
  }

  async execSession(id: string, input: ExecSessionRequest): Promise<ExecSessionResponse> {
    return this.request<ExecSessionResponse>(`/v1/sessions/${encodeURIComponent(id)}/exec`, {
      method: "POST",
      body: input,
    });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.target.token !== undefined) {
      headers["authorization"] = `Bearer ${this.target.token}`;
    }

    let response;
    try {
      response = await sendRequest(this.target, path, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Request to ${describeTarget(this.target)}${path} failed: ${message}`);
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401) {
        throw new Error("unauthorized - set PTYS_TOKEN or --token");
      }
      const detail = errorDetail(response.body);
      throw new HttpStatusError(response.status, response.statusText, detail.length === 0 ? undefined : detail.slice(2));
    }

    if (response.status === 204 || response.body.length === 0) {
      return undefined as T;
    }

    return JSON.parse(response.body) as T;
  }
}
