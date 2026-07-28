# ptys

Run terminal apps as long-lived server-side sessions; attach and detach from anywhere.

## Install

```sh
npm i -g @pty-server/ptys
```

ptys is currently in prerelease, so that command finds nothing yet. Until the first stable version, install
the prerelease explicitly:

```sh
npm i -g @pty-server/ptys@next
```

## Requirements

Node.js 24 or newer, on Linux.

This first release is developed and tested on Linux only. ptys is expected to work on macOS, and on Windows
apart from daemon mode (`ptys server start`), but neither is covered by CI yet - `node-pty` prebuilds,
signals, terminal I/O, and shell selection are all platform-sensitive. Coverage for other platforms is
planned.

`node-pty` is a native addon. Where no prebuilt binary matches, building it needs a C++ toolchain such as
`python3`, `make`, and a C compiler.

## Quickstart

```sh
# Start a background server. It binds nothing to the network: local commands
# reach it over a private Unix socket, and need no token.
ptys server start

# Only if a browser or a remote machine has to reach it: bind an address.
# That, and only that, generates the token, printed once (see Security).
ptys server start --instance browser --listen 127.0.0.1:7801

# Create a detached session, or create and attach immediately.
ptys start --name shell bash
ptys run --name editor vim

# Inspect, attach, and stop a session.
ptys list
ptys attach <id>
ptys kill <id>

# Stop the background server.
ptys server stop
```

## Commands

| Command | Notable flags |
| --- | --- |
| `ptys server` / `ptys server run` | Run the server in the foreground. `--instance`, `--listen` (repeatable), `--token`, `--no-auth`, `--allow-origin`, `--browse-root`, `--shell`, `--scrollback`, `--max-closed-sessions` |
| `ptys server start` | Start a background daemon (not supported on Windows). Same server flags as `server run`. |
| `ptys server stop` | Stop a daemon. `--instance`, `--all` |
| `ptys server status` | Show daemon status. `--instance`, `--json` |
| `ptys server restart` | Restart a daemon. `--instance` |
| `ptys start [cmd] [args...]` | Create a detached session. Omitting `cmd` starts the server user's default shell. `--instance`, `--server`, `--name`, `--cwd`, `--env K=V`, `--size WxH`, `--follow-size`, `--token` |
| `ptys run [cmd] [args...]` | Create a session and attach to it. Omitting `cmd` starts the server user's default shell. `--instance`, `--server`, `--name`, `--cwd`, `--env K=V`, `--size WxH`, `--follow-size`, `--lossy`, `--token` |
| `ptys list` | List sessions. `--instance`, `--server`, `--token`, `--json` |
| `ptys kill <id>` | Stop a session by ID, ID prefix, or name. `--instance`, `--server`, `--token`, `--signal` |
| `ptys rename <id> <name>` | Change a session name. `--instance`, `--server`, `--token` |
| `ptys event <json>` | Emit an event from an application running in a session. `--request`, `--timeout` |
| `ptys event-listener` | Print global session events as NDJSON. `--instance`, `--server`, `--token` |
| `ptys config origin list` | List origins currently allowed to make browser requests. `--instance`, `--server`, `--token`, `--json` |
| `ptys config origin allow/remove <origin>` | Change the browser Origin allowlist immediately. `--instance`, `--server`, `--token`, `--json` |
| `ptys config listen list` | List the addresses a running server is bound to. Control socket only: `--instance`, `--json` |
| `ptys config listen add/remove <addr>` | Bind or unbind a TCP address on a running server. Control socket only: `--instance`, `--json` |
| `ptys attach <id>` | Attach by ID, ID prefix, or name. `--instance`, `--server`, `--read-only`, `--lossy`, `--token` |

Without `--cwd`, a session starts in the server's working directory.

### Instances and addresses

A server is identified by its **instance name**, not by an address. `--instance work` names the pidfile, log and control socket under `~/.ptys/run` (`work.pid`, `work.log`, `work.sock`); the default name is `default`. Several instances can run side by side, and a socket-only one binds nothing at all.

`--listen host:port` is separate, and purely about binding. It is repeatable, so one server can answer on several addresses, and passing it at all is what creates the token:

```sh
ptys server start                                                  # control socket only
ptys server start --listen 127.0.0.1:7801                          # + a loopback listener
ptys server start --instance lan --listen 127.0.0.1:7801 --listen 0.0.0.0:8080
```

Client commands mirror the split. `--instance <name>` (or `PTYS_INSTANCE`) reaches a local server over its control socket, with no credential. `--server <addr>` (or `PTYS_SERVER`) reaches an address over TCP, with a token - that is the path for remote servers and for Windows, which has no control socket. Passing both is an error. Every command that takes `--server` also takes `--insecure`; see [Security](#security).

## Server configuration

`~/.ptys.json` is an optional JSON file containing defaults for `ptys server` and `ptys server start`. Explicit command-line flags override these defaults; repeated `--allow-origin`, `--browse-root` and `--listen` flags replace their corresponding arrays. `server stop` and `server restart` also use the configured `instance` when that flag is omitted, while `server status` lists every daemon unless `--instance` names one.

```json
{
  "instance": "default",
  "listen": ["127.0.0.1:7801"],
  "noAuth": false,
  "allowOrigins": ["https://app.example"],
  "browseRoots": ["/absolute/path/to/workspaces"],
  "shell": "/bin/zsh",
  "scrollback": 5000,
  "maxClosedSessions": 100
}
```

All fields are optional. `instance` starts with a letter or digit and holds only letters, digits, dots, dashes and underscores (at most 64 characters); `listen` is an array of `host:port` strings, with IPv6 bracketed as `[::1]:7801`, and an omitted or empty one means no TCP listener at all; `noAuth` is a boolean; `allowOrigins` is an array of absolute `http(s)` origins; `browseRoots` is an array of existing directories; `shell` is a non-empty command run by sessions that name none, and defaults to this user's passwd shell rather than the daemon's inherited `SHELL`, which froze when the daemon detached; and `scrollback` and `maxClosedSessions` are non-negative integers. Unknown fields are rejected. Tokens are deliberately not accepted in this file: use `--token`, `PTYS_TOKEN`, or the existing `~/.ptys/token` store.

The same rules apply to the equivalent command-line flags, and they are checked before anything is started, so a rejected value never leaves a listener or a pidfile behind.

`maxClosedSessions` controls how many exited sessions remain available for `ptys list` and late-attach final-screen viewing. The default is 100; set it to `0` to remove sessions as soon as they exit. A session no client has attached to yet is held for 30 seconds regardless, so `ptys run` still collects the output and exit status of a command that finishes before it attaches.

JSON HTTP request bodies are limited to 64 KiB.

`--allow-origin` seeds an in-memory browser Origin allowlist at startup. You can change it without a restart using `ptys config origin allow https://app.example` or `ptys config origin remove https://app.example`; dynamic changes are lost when the server stops.

`--listen` works the same way. A running server can be opened up, or closed again, without a restart:

```sh
ptys config listen add 127.0.0.1:7801     # prints the token if this is the first listener
ptys config listen list
ptys config listen remove 127.0.0.1:7801
```

These commands are accepted **only over the control socket**, so they take `--instance`, never `--server`: opening a network listener is exactly the privilege a network caller must not have, and the reply carries the token. Like runtime origins, runtime listeners are lost when the server stops - `ptys server restart` replays the `--listen` addresses the daemon was started with, and nothing else. `ptys server status` shows what it is bound to now.

`--no-auth` is for trusted local use only. It refuses any non-loopback `--listen` address, accepts API requests only when their `Host` header exactly names one of the bound addresses, and requires `Content-Type: application/json` for JSON API requests. Use normal token authentication for any less-trusted setup, and read [Security](#security) before exposing a server beyond loopback.

While attached with `ptys attach` or `ptys run`, press `Ctrl-P` then `Ctrl-Q` to detach without stopping the session. To send `Ctrl-P` to the attached program, press `Ctrl-P` twice; a lone `Ctrl-P` is held until the next keypress.

Attach does not reconnect. A deliberate detach exits `0` and a finished session exits with the program's own status, but a dropped connection - including the server dropping a client that cannot keep up - exits nonzero with the reason on stderr, so scripts never mistake lost output for success. Reattach with `ptys attach <id>`; the session is untouched.

## Security

A ptys token is shell access: anyone holding it can spawn processes as the server's user. Token
authentication proves *who* is calling; it does not encrypt anything.

Nothing is bound to the network unless `--listen` asks for it, and a server with no listener never creates a
token at all - there is no credential to leak, and no port for anyone to reach.

Local commands do not use the token in any case. The server accepts requests on a Unix socket in a private
(0700) directory - `~/.ptys/run/<instance>.sock`, or `$XDG_RUNTIME_DIR/ptys` / `/tmp/ptys-<uid>` when the
home path is too long for a socket address. Only the server's own user can connect to it, so no credential
is presented and none is asked for, and the CLI never sends a stored token to a loopback TCP port - on a
shared machine, another user can occupy that port while the server is stopped.
Set `PTYS_TOKEN` or pass `--token` for remote servers, for browser clients, and on Windows, which has no
equivalent socket and therefore requires `--listen`. Over plaintext `http://`, both the
bearer token and the full terminal stream are readable - and the token is replayable - by anyone on the
network path.

ptys does not terminate TLS itself. For any non-loopback setup, run it behind a TLS reverse proxy and point
clients at the `https://` address; attach and event streams follow to `wss://` automatically. Minimal nginx
example (the `Upgrade`/`Connection` headers are required - attach and events are WebSocket):

```nginx
server {
  listen 443 ssl;
  server_name ptys.example;
  ssl_certificate     /etc/ssl/ptys.example.crt;
  ssl_certificate_key /etc/ssl/ptys.example.key;

  location / {
    proxy_pass http://127.0.0.1:7801;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1d;
  }
}
```

Keep the ptys server itself on a loopback `--listen` address so the proxy is the only way in.

Client commands refuse a plaintext `http://` address whose host is not loopback:

```
$ ptys list --server ptys.example:7801
ptys: refusing plaintext http:// to non-loopback host ptys.example; use https:// (terminate TLS in front of ptys) or pass --insecure / PTYS_INSECURE=1
```

`--insecure`, or `PTYS_INSECURE=1`, lifts that refusal for setups where the network is already trusted (for
example an established VPN or SSH tunnel). It disables a safety check, not a feature - the traffic is still
plaintext.

## Events

Applications running inside a session can emit live events for global listeners:

```sh
ptys event '{"type":"notification","data":{"message":"job done"}}'
ptys event --request --timeout 10 '{"type":"confirmation","data":{"ask":"continue?"}}'
ptys event-listener
```

Every listener receives NDJSON envelopes containing `sessionId`, `type`, and `data`. Built-in events include `session.created` (the public session record), `session.title`, `session.updated`, and `session.exited` (with `{ code, signal?, at }`). Request events print only the first reply's `data`; `--timeout 0` waits indefinitely after a listener is connected.

The companion GUI/native client project is called choux.

## API documentation

The generated [OpenAPI HTTP contract](docs/openapi.yaml) and [AsyncAPI WebSocket contract](docs/asyncapi.yaml) live in `docs/`. Load the OpenAPI file in a Swagger UI; use an AsyncAPI-compatible viewer for the terminal stream.

## Versioning

`@pty-server/ptys` and `@pty-server/protocol` are versioned and released in lockstep: both carry the same
version and are published together from a single `vX.Y.Z` tag, which the release workflow refuses unless it
matches both `package.json` versions exactly. A prerelease version such as `0.1.0-next.0` is published under
the `next` dist tag, never `latest`, so it reaches only installs that ask for it by tag or by exact version. The wire protocol carries its own integer version, reported in
`/v1/info` and in the attach handshake; clients require an exact match and refuse to talk to a server
advertising anything else.

## License

MIT; see [LICENSE](LICENSE).
