#!/usr/bin/env bash
# Boot Vite + Tauri + Xvfb for the demo recorder. Intended to be run inside
# a `nix-shell -p mesa libglvnd webkitgtk_4_1 glib gtk3 libsoup_3 dbus
# xorg.xorgserver nodejs pnpm` shell.
#
# Writes PIDs to /tmp/demo-pids, streams logs to /tmp/{xvfb,vite,tauri}.log.
# Blocks until ctrl-c. Clean up with tests/demo/teardown.sh.

set -euo pipefail
cd "$(dirname "$0")/../.."

MESA_OUT=${MESA_OUT:-$(nix-build '<nixpkgs>' -A mesa --no-out-link 2>/dev/null)}
GLVND_OUT=${GLVND_OUT:-$(nix-build '<nixpkgs>' -A libglvnd --no-out-link 2>/dev/null)}

# Software GL.
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export LIBGL_DRIVERS_PATH="$MESA_OUT/lib/dri"
export __EGL_VENDOR_LIBRARY_DIRS="$MESA_OUT/share/glvnd/egl_vendor.d"
export LD_LIBRARY_PATH="$GLVND_OUT/lib:$MESA_OUT/lib:${LD_LIBRARY_PATH:-}"

rm -f /tmp/demo-pids /tmp/xvfb.log /tmp/vite.log /tmp/tauri.log

# 1. Xvfb :77
rm -f /tmp/.X11-unix/X77
Xvfb :77 -screen 0 1280x900x24 +extension GLX +extension RENDER +extension RANDR -noreset -ac > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
echo "xvfb=$XVFB_PID" >> /tmp/demo-pids
export DISPLAY=:77
sleep 1

# 2. dbus
cat > /tmp/dbus.conf <<DBUS
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <standard_session_servicedirs/>
  <policy context='default'>
    <allow send_destination='*'/>
    <allow eavesdrop='true'/>
    <allow own='*'/>
  </policy>
</busconfig>
DBUS
dbus-daemon --config-file=/tmp/dbus.conf --fork --print-address > /tmp/dbus-addr.txt
export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/dbus-addr.txt)

# 3. Vite dev server
pushd example > /dev/null
pnpm exec vite --host 127.0.0.1 --port 5174 > /tmp/vite.log 2>&1 &
VITE_PID=$!
popd > /dev/null
echo "vite=$VITE_PID" >> /tmp/demo-pids

# 4. Tauri binary
export GDK_BACKEND=x11
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
RUST_LOG=info ./target/debug/browser-proxy-example > /tmp/tauri.log 2>&1 &
TAURI_PID=$!
echo "tauri=$TAURI_PID" >> /tmp/demo-pids

# 5. Wait for both to come up.
echo "→ waiting for vite on 5174 and proxy on 1421..."
for i in $(seq 1 60); do
  if curl -sf -m 1 http://127.0.0.1:5174/ >/dev/null 2>&1 && \
     curl -sf -m 1 http://127.0.0.1:1421/health >/dev/null 2>&1; then
    echo "✓ stack is up"
    break
  fi
  sleep 0.5
done

if ! curl -sf -m 2 http://127.0.0.1:1421/health >/dev/null 2>&1; then
  echo "✗ proxy never came up"
  tail -30 /tmp/tauri.log
  exit 1
fi

# 6. Done. Keep running so the demo recorder can hit the stack.
echo "→ stack ready: vite=http://127.0.0.1:5174  proxy=http://127.0.0.1:1421"
echo "→ PIDs: $(cat /tmp/demo-pids | tr '\n' ' ')"
echo "→ ctrl-c to tear down, or run tests/demo/teardown.sh"
wait
