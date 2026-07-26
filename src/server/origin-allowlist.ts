export class OriginAllowlist {
  private readonly origins: Set<string>;

  constructor(origins: Iterable<string> = []) {
    this.origins = new Set(origins);
  }

  has(origin: string): boolean {
    return this.origins.has(origin);
  }

  add(origin: string): boolean {
    return !this.origins.has(origin) && (this.origins.add(origin), true);
  }

  remove(origin: string): boolean {
    return this.origins.delete(origin);
  }

  list(): string[] {
    return [...this.origins].sort();
  }
}

export function isValidOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
  } catch {
    return false;
  }
}
