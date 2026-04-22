#!/usr/bin/env bash
set -u
if [ -f /tmp/demo-pids ]; then
  while IFS='=' read -r name pid; do
    kill "$pid" 2>/dev/null || true
  done < /tmp/demo-pids
  rm -f /tmp/demo-pids
fi
pkill -f 'browser-proxy-example' 2>/dev/null || true
pkill -f 'vite --host' 2>/dev/null || true
pkill -f 'Xvfb :77' 2>/dev/null || true
echo "teardown done"
