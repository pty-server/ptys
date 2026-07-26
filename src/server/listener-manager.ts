import type * as http from "node:http";
import { getOrCreateToken } from "./auth.js";
import { closeHttpServer } from "./close-http-server.js";
import { formatListenAddress, type ListenAddress, validateServerOptions } from "./server-options.js";

export class AddressInUseError extends Error {}

export type PublicListenerFactory = (token: string | undefined) => http.Server;

export interface ListenerManagerOptions {
  noAuth: boolean;
  token?: string;
  initialListeners: number;
  onChange?: (listeners: ListenAddress[]) => void;
}

/** Owns the bound TCP servers and the single token they all authenticate with. */
export class ListenerManager {
  private readonly bound = new Map<string, { address: ListenAddress; server: http.Server }>();
  private readonly options: ListenerManagerOptions;
  private token: string | undefined;

  constructor(options: ListenerManagerOptions) {
    this.options = options;
    // No TCP listener means no token at all - nothing is reachable that could present one.
    this.token = options.noAuth || options.initialListeners === 0 ? undefined : getOrCreateToken(options.token);
  }

  list(): ListenAddress[] {
    return [...this.bound.values()].map(({ address }) => address);
  }

  async add(address: ListenAddress, createListener: PublicListenerFactory): Promise<string | undefined> {
    validateServerOptions({ listen: [address], noAuth: this.options.noAuth });
    // Minting inside the factory keeps `bind` free to reject a duplicate address first, so a
    // rejected request never leaves a freshly written token behind.
    await this.bind(address, () => {
      this.token ??= this.options.noAuth ? undefined : getOrCreateToken(this.options.token);
      return createListener(this.token);
    });
    this.options.onChange?.(this.list());
    return this.token;
  }

  async bindInitial(addresses: ListenAddress[], createListener: PublicListenerFactory): Promise<void> {
    for (const address of addresses) {
      await this.bind(address, () => createListener(this.token));
    }
  }

  async remove(address: ListenAddress): Promise<boolean> {
    const key = formatListenAddress(address);
    const listener = this.bound.get(key);
    if (listener === undefined) {
      return false;
    }
    this.bound.delete(key);
    await closeHttpServer(listener.server);
    this.options.onChange?.(this.list());
    return true;
  }

  async closeAll(): Promise<void> {
    const servers = [...this.bound.values()].map(({ server }) => server);
    this.bound.clear();
    for (const server of servers) {
      await closeHttpServer(server);
    }
  }

  private async bind(address: ListenAddress, create: () => http.Server): Promise<void> {
    const key = formatListenAddress(address);
    if (this.bound.has(key)) {
      throw new AddressInUseError(`already listening on ${key}`);
    }
    const server = create();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => reject(
        error.code === "EADDRINUSE"
          ? new AddressInUseError(`cannot listen on ${key}: ${error.message}`)
          : new Error(`cannot listen on ${key}: ${error.message}`, { cause: error }),
      );
      server.once("error", onError);
      server.listen(address.port, address.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.bound.set(key, { address, server });
  }
}
