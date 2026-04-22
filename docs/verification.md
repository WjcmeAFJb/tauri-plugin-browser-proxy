# Verification log

What was tested and what still requires a human at a real display.

## Automated ✅

| Check                                        | How                                | Result |
|---                                           |---                                 |---     |
| Rust plugin compiles                         | `cargo check`                      | clean  |
| Rust plugin passes clippy                    | `cargo clippy --no-deps`           | clean  |
| Rust unit tests                              | `cargo test` (3 tests)             | pass   |
| Example Tauri binary compiles                | `cargo check -p browser-proxy-example` | clean |
| JS package builds (ESM + CJS + DTS)          | `pnpm --filter … build`            | clean  |
| Example frontend typechecks                  | `tsc --noEmit`                     | clean  |
| Vite plugin injects shim                     | `curl http://127.0.0.1:5174/` → inspect `<head>` | script tag present with correct proxy URL |
| HTTP server starts on deterministic port     | `curl http://127.0.0.1:1421/health` | `ok` |
| `/config` returns expected JSON              | curl                               | `{"host":"127.0.0.1","port":1421,"url":"…"}` |
| CORS preflight works                         | curl with `OPTIONS`                | headers mirrored |
| **Shim wire protocol**                       | Playwright against mock HTTP server (`tests/specs/shim-unit.spec.ts`) | **pass** |
| &nbsp;&nbsp; ↳ POST /invoke format           | ⬑ verified outbound body has `{cmd, args}` with encoded binary | pass |
| &nbsp;&nbsp; ↳ binary round-trip             | Uint8Array([1..8,0xff,0,0x80]) sent, reversed result decoded identically | pass |
| &nbsp;&nbsp; ↳ listen → SSE → dispatch       | emit('xyz') → seen by listener with exact payload | pass |
| &nbsp;&nbsp; ↳ base64 framing                | decoded to the expected `AQIDBAUGBwj/AIA=` on the wire | pass |

## Requires a real display (manual)

The full webview round-trip (browser tab → HTTP → Tauri webview via
`eval` → Rust command → relay_result → HTTP response) exercises the
WebKitGTK runtime. In headless Xvfb on recent WebKit 2.52, EGL
initialization refuses with `EGL_BAD_PARAMETER` and the webview aborts —
a known WebKit-in-Xvfb limitation unrelated to this plugin. On any
machine with a real display, run:

```bash
# Terminal 1 — boots both Vite and the Tauri binary.
pnpm tauri:example

# Terminal 2 — in a normal browser.
xdg-open http://127.0.0.1:5174
# (or open it by hand — Chrome, Firefox, Safari, whatever)
```

Checklist to walk through:

1. **Banner reads "connected http://127.0.0.1:1421"** — the
   `plugin:browser-proxy|proxy_url` invoke round-trip works.
2. Click **`greet('world')`** → `Hello, world!` — regular invoke works.
3. Set **path** to `/etc/hostname` (or any file), click **read bytes** —
   you should see `type=Uint8Array`, a nonzero `len`, the hex dump of the
   first 64 bytes, and the UTF-8 rendering of the first 128 bytes.
   Confirms binary round-trip through the *real* Tauri fs plugin.
4. Set **watch path** to `/tmp`, click **start watch**. In another
   terminal run `touch /tmp/browser-proxy-demo`. The UI should log a
   `create` event with the path. Confirms Rust-emitted events reach the
   browser tab via SSE.
5. Click **emit 'ping'**. You should see `got pong: "…" in XX ms` —
   confirms `emit → Rust → emit → listen` works in both directions.
6. Click **send notification**. On a graphical session you should see an
   OS notification; otherwise the UI reads `sent.`. Confirms the
   notification plugin works through the proxy.

Running the Playwright `smoke.spec.ts` suite automates this checklist:

```bash
pnpm --filter browser-proxy-e2e test
```

It depends on `pnpm tauri dev` being runnable (WebKit + display).

## Known limitations surfaced during verification

- **`tsc --noEmit`** picks up `src/main.ts` but not `vite.config.ts` — the
  latter is handled by Vite's own esbuild pipeline. This is expected.
- **Clippy's `io_other_error` hint** was applied — the fix (`Error::other`)
  needs Rust ≥1.74. The flake pins 1.94, safe.
- **Rust doc-tests** are empty — there are no `///` examples yet. OK
  for an early release.
