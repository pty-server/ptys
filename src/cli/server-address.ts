import { isLoopbackHost } from "../server/auth.js";

const DEFAULT_SERVER_ADDRESS = "localhost:7801";

export function resolveServerBaseUrl(flagValue?: string, insecure?: boolean): string {
  const address = flagValue ?? process.env.PTYS_SERVER ?? DEFAULT_SERVER_ADDRESS;
  const withScheme = /^https?:\/\//i.test(address)
    ? address
    : `http://${address}`;
  const baseUrl = withScheme.replace(/\/+$/, "");

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`ptys: invalid server address ${address}`);
  }

  const allowInsecure = insecure === true || process.env.PTYS_INSECURE === "1";
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowInsecure) {
    throw new Error(
      `ptys: refusing plaintext http:// to non-loopback host ${url.hostname}; ` +
      "use https:// (terminate TLS in front of ptys) or pass --insecure / PTYS_INSECURE=1",
    );
  }

  return baseUrl;
}
