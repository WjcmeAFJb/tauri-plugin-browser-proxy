# Demo video

End-to-end recording of the Tauri **fs** + **notification** + custom-event
plugins flowing through `tauri-plugin-browser-proxy` into an ordinary
browser tab.

## What's here

| File                         | Size   | Notes                                                   |
|---                           |---     |---                                                      |
| `browser-proxy-demo.webm`    | ~1.6 MB | Primary deliverable. VP8, 1280×900, 22 s.               |
| `browser-proxy-demo.mp4`     | ~4.4 MB | MPEG-4 Part 2 transcode. Plays in any modern player.    |
| `frames/frame-01.jpg` … `-22.jpg` | 22× ~70 KB | One frame per second, for scrubbing without a video player. |
| `run-demo.mjs`               |         | The script that produced the recording.                 |
| `boot-full-stack.sh`         |         | Boots Xvfb + Mesa (llvmpipe) + dbus + Vite + Tauri.    |
| `teardown.sh`                |         | Kills everything the boot script started.               |

## Reproduce

```bash
# 1. Build the Rust binary + JS package once.
nix develop
pnpm install
pnpm --filter tauri-plugin-browser-proxy-js build
cargo build -p browser-proxy-example

# 2. Boot the stack (Xvfb + Tauri + Vite). Blocks until ctrl-c.
nix-shell -p mesa libglvnd webkitgtk_4_1 glib gtk3 libsoup_3 \
              dbus xorg.xorgserver nodejs_20 pnpm \
  --run 'bash tests/demo/boot-full-stack.sh'

# 3. In another terminal, run the recorder.
cd tests && node demo/run-demo.mjs
```

## What the video shows (sequence)

| Seconds | Banner                                                   | What's visible                                                               |
|---      |---                                                       |---                                                                           |
| 0-2     | `1/6 connecting to Tauri proxy on :1421`                 | Status flips from "checking…" to green "connected http://127.0.0.1:1421"    |
| 2-4     | `2/6 invoke('greet', ...)`                               | `Hello, world! — from Tauri 2 via the browser proxy.`                       |
| 4-6     | `3/6 fs.readFile(...) → Uint8Array`                      | `type=Uint8Array len=13 first 64 bytes (hex): 00 01 02 03 04 05 06 07 ff de ad be ef` — the exact bytes the test script wrote to `data.bin` |
| 6-8     | `4/6 fs.watch() — external mutations will stream in`     | Left panel lists `data.bin, hello.txt, notes.md, README.txt` before any mutation |
| 8-10    | `4/6 fs.watch — creating hello.txt`                      | — already existed; access events in the right panel                         |
| 10-12   | `4/6 fs.watch — appending to hello.txt`                  | New access/write events scroll in                                            |
| 12-14   | `4/6 fs.watch — writing binary snapshot.dat`             | Left panel gains `snapshot.dat`; right panel shows the corresponding events |
| 14-16   | `4/6 fs.watch — overwriting notes.md`                    | Write events for notes.md                                                    |
| 16-18   | `4/6 fs.watch — deleting README.txt`                     | **Left panel loses `README.txt`** — the fs.readDir after the watcher event reflects the deletion |
| 18-20   | `5/6 stopping watcher`                                   | Watcher panel shows `stopped.`                                               |
| 20-22   | `6/6 emit('ping') → Rust listens → emit('pong')`         | `got pong: ...` result, proves emit/listen works through SSE                |
| 22      | `✓ demo complete`                                        | Final summary state                                                          |

Every click, every Uint8Array, every watch event, and every listen
callback traveled through `POST /invoke` or the `/events` SSE stream —
not a shred of it went through Tauri's native IPC to the browser tab.

## What the headless quirks were

WebKitGTK 2.52 refuses to initialize EGL under a plain Xvfb. The fix is
in `boot-full-stack.sh`: install Mesa + libglvnd, point
`__EGL_VENDOR_LIBRARY_DIRS` at Mesa's ICD json, set `LIBGL_ALWAYS_SOFTWARE=1`
and `GALLIUM_DRIVER=llvmpipe`, and pass `-extension GLX +extension RENDER`
to Xvfb. On a real desktop none of this is necessary — WebKit uses the
system GPU.
