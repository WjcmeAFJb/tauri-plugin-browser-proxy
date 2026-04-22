# Architecture

## Problem

A Tauri 2 frontend can't be opened in an ordinary browser because
`window.__TAURI_INTERNALS__` is only injected into Tauri's own webview.
Everything in `@tauri-apps/api` — `invoke`, `listen`, `emit`, the plugin
bindings — calls into that global. In Chrome it doesn't exist, so the
first `invoke()` throws `TypeError: Cannot read properties of undefined`.

Three pieces have to move to make the browser tab usable:

1. **Invoke** (frontend → Rust) needs a transport.
2. **Events** (Rust → frontend) need a transport in the other direction.
3. **Binary** values (`fs.readFile`, image bytes, etc.) need to survive
   the JSON-only wire.

## High level

```
                 ┌─────────── browser tab ──────────┐
                 │  any Vite dev server @ :5173      │
                 │                                    │
         invoke ─┼──► fake __TAURI_INTERNALS__.invoke │
                 │       ↓ POST /invoke               │
                 │                                    │
         listen ─┼──► intercept plugin:event|listen   │
                 │       ↓ POST /subscribe            │
                 │   EventSource('/events')           │
                 │       ↑ SSE                        │
                 └───────────────────────────────────┘
                             ▲      ▲
                    /invoke  │      │  /events
                    POST     │      │  SSE stream
                             │      │
                 ┌───────────┴──────┴───── Tauri app ───────────────┐
                 │                                                   │
                 │   axum server on 127.0.0.1:1421                   │
                 │      • POST /invoke      (pending oneshot)         │
                 │      • GET  /events      (broadcast channel)       │
                 │      • POST /subscribe   (await listener alive)    │
                 │                                                   │
                 │   bridge webview (the Tauri native window)        │
                 │      • interceptor: encode/decode/subscribe       │
                 │      • plugin:browser-proxy|register_bridge        │
                 │      • plugin:browser-proxy|relay_result           │
                 │      • plugin:browser-proxy|relay_event            │
                 │                                                   │
                 │   Tauri core                                      │
                 │      • fs, notification, dialog, http, custom cmds │
                 └───────────────────────────────────────────────────┘
```

## Invoke path

1. The frontend calls `invoke('plugin:fs|read_file', {path})`.
2. In the **browser tab**, our shim intercepts. It JSON-encodes the args
   (walking the graph, turning `Uint8Array` into `{__browser_proxy_binary__: true, kind, data}`),
   and sends `POST /invoke { cmd, args }`.
3. In the **Tauri app**, the server:
   - generates a UUID,
   - stores a `oneshot::Sender` in a `pending` map keyed by that id,
   - `eval`s a snippet inside the bridge webview:
     ```js
     window.__TAURI_INTERNALS__.invoke(cmd, decode(args))
       .then(r => relay_result(id, ok=true, data=encode(r)))
       .catch(e => relay_result(id, ok=false, error=String(e)));
     ```
4. Inside the bridge webview, the real `invoke` runs. Tauri's permission
   system, plugin routing, logger, etc. all execute normally.
5. The response hits `relay_result`, which wakes the oneshot.
6. The server sends the HTTP response.
7. The browser shim decodes the payload (binary objects become live
   typed arrays again) and resolves the `invoke()` promise.

## Event path

1. The frontend calls `listen('file-changed', handler)`.
2. The shim stores the handler locally, and **before** resolving, does
   `POST /subscribe {event}`. The server doesn't return 204 until the
   bridge webview's real `listen()` has been awaited. This ordering keeps
   `listen();emit();` race-free.
3. When Rust later emits `file-changed` — from `fs.watch`, or any
   `app.emit` — the bridge webview's listener fires and calls
   `plugin:browser-proxy|relay_event`.
4. The plugin pushes the frame into a `tokio::broadcast` channel.
5. Every connected SSE client gets a `tauri` event with the encoded
   payload.
6. The browser shim's `EventSource` decodes the payload and runs local
   listeners.

## Binary codec

`plugin/src-js/binary.ts` defines `encode` and `decode`. The Tauri side
has an identical hand-rolled copy in `plugin/dist/interceptor.bundle.js`.

| Input                    | Wire form                                       |
|---                       |---                                              |
| `ArrayBuffer`            | `{__browser_proxy_binary__: true, kind: 'ArrayBuffer', data: b64}` |
| `Uint8Array` / `Int8Array` / `Float64Array` / … | same shape, `kind` = the TypedArray name |
| `Date`                   | `{__browser_proxy_date__: true, iso: "..."}`    |
| `Map` / `Set`            | `{__browser_proxy_map__ or _set__: true, entries/items: …}` |
| `null` / `number` / `string` / `boolean` | passthrough                  |
| plain object             | recursive, passthrough keys                     |

Base64 chunking at 32 KB keeps us out of the `String.fromCharCode`
argument-limit trap on large buffers.

`decode` is idempotent: running it on an already-live value returns the
same value. This matters because the shim's `transformCallback` wrapper
calls `decode` on event payloads that the SSE layer already decoded.

## CORS & determinism

Two practical problems with naively forwarding invoke over HTTP:

- **Random ports** (the default `tauri-plugin-localhost` behavior) force
  the frontend to discover the port at runtime, usually via Tauri itself
  — a chicken-and-egg loop.
- **Inadequate CORS** — reqwest/axum defaults reject browser preflights
  for non-simple content types. `application/json` triggers a preflight.

The plugin takes the opinionated route:

- **Deterministic port** — defaults to 1421. Change via
  `ProxyBuilder::port`. There is no discovery protocol; both sides just
  know.
- **Explicit CORS** — `AllowOrigin::list` seeded with every Vite/dev-
  server port you're likely to use, `AllowHeaders::mirror_request()` so
  every preflight just echoes the requested headers back.

If you need custom origins, pass them to `ProxyBuilder::allowed_origins`.
`"*"` is honored but *only enable it in dev* — it disables credentials-
safe origin checks.

## Why `eval` instead of calling `invoke_handler` directly?

Tauri's `invoke_handler` isn't public API. Even if it were, you'd lose
plugin middleware, permission checks, event listener scope — everything
that makes a command "the same command" as in production. Running the
invoke through the webview's JS runtime means the only thing that changes
in browser-mode is the *caller*; the Rust side sees an invoke identical
to one from the native webview.

The overhead is measurable (one eval, one IPC round-trip, one oneshot
wake) but tiny — typically <3 ms on localhost.
