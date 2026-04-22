#!/usr/bin/env bash
# Build the single shippable artifact:
#
#   dist/tauri-plugin-browser-proxy-js-<ver>.tgz
#     — `npm pack` output of the JS package. Consumers install it by URL:
#         pnpm add https://github.com/…/releases/download/vX/…-X.tgz
#
# The Rust crate is NOT packaged — consumers depend on it as a Cargo git
# dependency pointing at a tag in this repo, so there's no artifact to
# produce on the Rust side.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

VERSION=$(awk -F '"' '/^version *=/ { print $2; exit }' Cargo.toml)

echo "→ packaging tauri-plugin-browser-proxy-js v${VERSION}"

OUT="$ROOT/dist"
mkdir -p "$OUT"

# 1. Build the JS package (fresh).
echo "→ building JS package"
( cd "$ROOT/plugin" && pnpm install --silent && pnpm build ) >/dev/null

# 2. Stage a clean copy with a consumer-friendly package.json.
STAGING="$ROOT/dist/staging-${VERSION}"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -r "$ROOT/plugin/dist" "$STAGING/"
cp "$ROOT/plugin/package.json" "$STAGING/package.json"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$STAGING/README.md"
[ -f "$ROOT/LICENSE"   ] && cp "$ROOT/LICENSE"   "$STAGING/LICENSE"

# Strip workspace-only bits (scripts, devDeps) — they'd just confuse consumers.
python3 - <<PY
import json, pathlib
p = pathlib.Path("$STAGING/package.json")
pkg = json.loads(p.read_text())
pkg.pop("scripts", None)
pkg.pop("devDependencies", None)
pkg["files"] = ["dist", "LICENSE", "README.md"]
p.write_text(json.dumps(pkg, indent=2) + "\n")
PY

# 3. `npm pack` — produces tauri-plugin-browser-proxy-js-<ver>.tgz.
echo "→ producing npm pack"
( cd "$STAGING" && npm pack --pack-destination "$OUT" >/dev/null )

echo
echo "✓ artifact:"
ls -la "$OUT"/*.tgz | sed 's/^/  /'
