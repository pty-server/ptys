import { accessSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "@pty-server/protocol";

const PAGE_SIZE = 100;

interface Cursor {
  v: 1;
  path: string;
  q: string;
  after: [string, string];
}

function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.name !== right.name) {
    return left.name.localeCompare(right.name) || (left.name < right.name ? -1 : 1);
  }
  if (left.path !== right.path) {
    return left.path.localeCompare(right.path) || (left.path < right.path ? -1 : 1);
  }
  return 0;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function entryFor(path: string): DirectoryEntry {
  return { name: basename(path) || path, path };
}

export function canonicalizeBrowseRoots(roots: string[] | undefined): string[] {
  const requested = roots === undefined || roots.length === 0 ? [homedir()] : roots;
  const canonical: string[] = [];
  for (const root of requested) {
    if (!isAbsolute(root)) throw new Error(`browse root must be an absolute path: ${root}`);
    let resolved: string;
    try {
      resolved = realpathSync(root);
      if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`browse root is not an existing directory: ${root}`);
    }
    if (!canonical.includes(resolved)) canonical.push(resolved);
  }
  return canonical;
}

function decodeCursor(value: string | undefined, path: string, q: string): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as Partial<Cursor>).v !== 1 || (parsed as Partial<Cursor>).path !== path ||
      (parsed as Partial<Cursor>).q !== q || !Array.isArray((parsed as Partial<Cursor>).after) ||
      (parsed as Partial<Cursor>).after?.length !== 2 ||
      typeof (parsed as Cursor).after[0] !== "string" || typeof (parsed as Cursor).after[1] !== "string"
    ) throw new Error("invalid cursor");
    return parsed as Cursor;
  } catch {
    throw new DirectoryUnavailableError();
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export class DirectoryUnavailableError extends Error {}

export class DirectoryBrowser {
  constructor(private readonly roots: string[]) {}

  list(path: string | undefined, q: string | undefined, cursorValue: string | undefined): DirectoryListing {
    if (path === undefined) {
      if (q !== undefined || cursorValue !== undefined) throw new DirectoryUnavailableError();
      return { breadcrumbs: [], entries: this.roots.map(entryFor) };
    }

    let current: string;
    try {
      current = realpathSync(path);
      if (!statSync(current).isDirectory() || !this.roots.some((root) => isWithin(current, root))) {
        throw new Error("outside root");
      }
      accessSync(current, 0o5);
    } catch {
      throw new DirectoryUnavailableError();
    }

    const filter = q ?? "";
    const cursor = decodeCursor(cursorValue, current, filter);
    const lowerFilter = filter.toLocaleLowerCase();
    const entries: DirectoryEntry[] = [];
    try {
      for (const dirent of readdirSync(current, { withFileTypes: true })) {
        const child = join(current, dirent.name);
        let resolved: string;
        try {
          resolved = realpathSync(child);
          if (!statSync(resolved).isDirectory() || !this.roots.some((root) => isWithin(resolved, root))) continue;
          accessSync(resolved, 0o5);
        } catch {
          continue;
        }
        if (lowerFilter.length > 0 && !dirent.name.toLocaleLowerCase().includes(lowerFilter)) continue;
        entries.push({ name: dirent.name, path: resolved });
      }
    } catch {
      throw new DirectoryUnavailableError();
    }
    entries.sort(compareEntries);
    const after = cursor?.after;
    const previous = after === undefined ? undefined : { name: after[0], path: after[1] };
    const remaining = previous === undefined
      ? entries
      : entries.filter((entry) => compareEntries(entry, previous) > 0);
    const page = remaining.slice(0, PAGE_SIZE);
    const nextCursor = remaining.length > PAGE_SIZE && page.length > 0
      ? encodeCursor({ v: 1, path: current, q: filter, after: [page.at(-1)!.name, page.at(-1)!.path] })
      : undefined;

    const root = this.roots.filter((candidate) => isWithin(current, candidate)).sort((a, b) => b.length - a.length)[0]!;
    const breadcrumbs = [root];
    let ancestor = current;
    const segments: string[] = [];
    while (ancestor !== root) {
      segments.push(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new DirectoryUnavailableError();
      ancestor = parent;
    }
    breadcrumbs.push(...segments.reverse());
    return { current: entryFor(current), breadcrumbs: breadcrumbs.map(entryFor), entries: page, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
}
