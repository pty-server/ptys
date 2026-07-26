import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type ServerControlMessage } from "@pty-server/protocol";
import { ApiClient } from "./api-client.js";
import type { ClientOptions } from "./client-command.js";
import { resolveSessionId } from "./session-resolver.js";
import { resolveTarget, type ServerTarget } from "./target.js";
import { webSocketHeaders, webSocketUrl } from "./websocket-url.js";

export interface AttachClientOptions extends ClientOptions {
  readOnly?: boolean;
  lossy?: boolean;
  exactSessionId?: boolean;
}

const CTRL_P = 0x10;
const CTRL_Q = 0x11;

const HANDSHAKE_TIMEOUT_MS = 10_000;

export async function runAttachClient(
  sessionIdOrPrefixOrName: string,
  options: AttachClientOptions,
): Promise<void> {
  const target = resolveTarget(options);
  const sessionId = options.exactSessionId === true
    ? sessionIdOrPrefixOrName
    : await resolveSessionId(new ApiClient(target), undefined, sessionIdOrPrefixOrName);

  const wsUrl = toWebSocketUrl(target, sessionId, options.readOnly ?? false, options.lossy ?? false);
  const ws = new WebSocket(wsUrl, webSocketHeaders(target));
  ws.binaryType = "nodebuffer";

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let pendingDetach = false;
    let closeIsExpected = false;

    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      const handler = (): void => {
        restore();
        process.kill(process.pid, signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const restore = (): void => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      (process.stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.();
      process.stdin.off("data", onStdinData);
      process.stdout.off("resize", onResize);
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
      clearTimeout(handshakeTimer);
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      restore();
      resolve();
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      restore();
      reject(error);
    };

    const detach = (): void => {
      closeIsExpected = true;
      finish();
      ws.close();
    };

    function onStdinData(chunk: Buffer): void {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const toSend: number[] = [];
      for (const byte of chunk) {
        if (pendingDetach) {
          pendingDetach = false;
          if (byte === CTRL_Q) {
            detach();
            return;
          }
          if (byte === CTRL_P) {
            toSend.push(CTRL_P);
          } else {
            toSend.push(CTRL_P, byte);
          }
          continue;
        }
        if (byte === CTRL_P) {
          pendingDetach = true;
          continue;
        }
        toSend.push(byte);
      }
      if (toSend.length > 0 && !options.readOnly) {
        ws.send(Buffer.from(toSend));
      }
    }

    function onResize(): void {
      if (options.readOnly || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(
        JSON.stringify({
          t: "resize",
          cols: process.stdout.columns,
          rows: process.stdout.rows,
        }),
      );
    }

    const startTerminal = (): void => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", onStdinData);
      process.stdout.on("resize", onResize);
    };

    let handshakeDone = false;
    const handshakeTimer = setTimeout(() => {
      fail(new Error(`ptys: server sent no protocol handshake within ${HANDSHAKE_TIMEOUT_MS}ms`));
      ws.close();
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();

    const completeHandshake = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) {
        fail(new Error("ptys: server sent terminal output before the protocol handshake"));
        ws.close();
        return;
      }
      let message: ServerControlMessage;
      try {
        message = JSON.parse(data.toString()) as ServerControlMessage;
      } catch {
        fail(new Error("ptys: server sent an unreadable protocol handshake"));
        ws.close();
        return;
      }
      if (message.t !== "ready") {
        fail(new Error(`ptys: expected a protocol handshake, got "${message.t}"`));
        ws.close();
        return;
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        const advice = message.protocol > PROTOCOL_VERSION
          ? "upgrade ptys"
          : "downgrade ptys, or upgrade the server";
        fail(new Error(
          `ptys: server speaks protocol ${message.protocol}, this CLI speaks ${PROTOCOL_VERSION}; ${advice}`,
        ));
        ws.close();
        return;
      }
      handshakeDone = true;
      clearTimeout(handshakeTimer);
      startTerminal();
    };

    ws.on("message", (data, isBinary) => {
      if (!handshakeDone) {
        completeHandshake(data, isBinary);
        return;
      }
      if (isBinary) {
        process.stdout.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      let message: ServerControlMessage;
      try {
        message = JSON.parse(data.toString()) as ServerControlMessage;
      } catch {
        return;
      }
      if (message.t === "exit") {
        closeIsExpected = true;
        process.exitCode = message.code;
        finish();
        ws.close();
        return;
      }
      if (message.t === "error") {
        closeIsExpected = true;
        fail(new Error(`ptys: ${message.reason}`));
        ws.close();
        return;
      }
    });

    ws.on("close", () => {
      if (!closeIsExpected) {
        fail(new Error(handshakeDone
          ? "ptys: connection to the session closed unexpectedly"
          : "ptys: server closed the connection before the protocol handshake"));
        return;
      }
      finish();
    });

    ws.on("error", (error) => {
      fail(error);
    });

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        fail(new Error("ptys: unauthorized - set PTYS_TOKEN or --token"));
        res.resume();
        return;
      }
      fail(new Error(`ptys: unexpected response ${res.statusCode}`));
      res.resume();
    });
  });
}


function toWebSocketUrl(target: ServerTarget, sessionId: string, readOnly: boolean, lossy: boolean): string {
  const params = new URLSearchParams();
  params.set("cols", String(process.stdout.columns ?? 80));
  params.set("rows", String(process.stdout.rows ?? 24));
  if (readOnly) {
    params.set("readonly", "1");
  }
  if (lossy) {
    params.set("lossy", "1");
  }
  return webSocketUrl(target, `/v1/sessions/${encodeURIComponent(sessionId)}/attach`, params);
}
