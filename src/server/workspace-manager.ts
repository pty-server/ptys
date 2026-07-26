import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { Workspace } from "@pty-server/protocol";

export class NotADirectoryError extends Error {}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private defaultWorkspaceId: string | undefined;

  create(options: { path: string }): Workspace {
    const realpath = realpathSync(options.path);
    if (!statSync(realpath).isDirectory()) {
      throw new NotADirectoryError("path is not a directory");
    }
    for (const workspace of this.workspaces.values()) {
      if (workspace.realpath === realpath) {
        return workspace;
      }
    }
    const workspace: Workspace = {
      id: randomUUID(),
      path: options.path,
      realpath,
      createdAt: Date.now(),
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  getOrCreateDefault(): Workspace {
    if (this.defaultWorkspaceId !== undefined) {
      const workspace = this.get(this.defaultWorkspaceId);
      if (workspace !== undefined) return workspace;
    }
    const workspace = this.create({ path: process.cwd() });
    this.defaultWorkspaceId = workspace.id;
    return workspace;
  }

  list(): Workspace[] {
    return [...this.workspaces.values()];
  }
}
