// Demo app. Runs in an ordinary browser tab thanks to the shim installed by
// the tauri-plugin-browser-proxy vite plugin. All the imports below are the
// normal @tauri-apps/* packages — they have no idea they are being proxied.

import { invoke } from '@tauri-apps/api/core';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { readFile, readDir, watch, type WatchEvent } from '@tauri-apps/plugin-fs';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

async function refreshStatus() {
  const el = $('in-watch-path') ? document.querySelector('[data-testid=proxy-status]')! : null;
  const status = document.querySelector<HTMLElement>('[data-testid=proxy-status]')!;
  try {
    const url = await invoke<string>('plugin:browser-proxy|proxy_url');
    status.textContent = `connected ${String(url)}`;
    status.classList.add('ok');
    status.classList.remove('err');
  } catch (e) {
    status.textContent = `not connected — is the Tauri app running? (${String(e)})`;
    status.classList.add('err');
    status.classList.remove('ok');
  }
}
refreshStatus();
setInterval(refreshStatus, 5000);

// 1. Regular invoke.
$('btn-greet').addEventListener('click', async () => {
  const out = $<HTMLPreElement>('out-greet');
  try {
    const r = await invoke<string>('greet', { name: 'world' });
    out.textContent = r;
  } catch (e) {
    out.textContent = `ERR: ${String(e)}`;
  }
});

// 2. Binary roundtrip via fs.readFile → Uint8Array.
$('btn-read-bytes').addEventListener('click', async () => {
  const out = $<HTMLPreElement>('out-read-bytes');
  const path = ($('in-path') as HTMLInputElement).value;
  try {
    const bytes = await readFile(path);
    const preview = Array.from(bytes.slice(0, 64))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    out.textContent =
      `type=${bytes.constructor.name} len=${bytes.byteLength}\n` +
      `first 64 bytes (hex): ${preview}\n` +
      `decoded utf-8: ${new TextDecoder().decode(bytes.slice(0, 128))}`;
  } catch (e) {
    out.textContent = `ERR: ${String(e)}`;
  }
});

// 3. Events via fs.watch + auto-refreshing directory listing.
let unwatch: UnlistenFn | null = null;
let treePollTimer: number | null = null;

async function refreshTree(path: string) {
  const out = $<HTMLPreElement>('out-tree');
  try {
    const entries = await readDir(path);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const lines = entries.map((e) => {
      const flag = e.isDirectory ? 'd' : e.isSymlink ? 'l' : '-';
      return `${flag}  ${e.name}`;
    });
    out.textContent = lines.length ? lines.join('\n') : '(empty)';
  } catch (e) {
    out.textContent = `ERR: ${String(e)}`;
  }
}

$('btn-watch').addEventListener('click', async () => {
  const out = $<HTMLPreElement>('out-watch');
  const path = ($('in-watch-path') as HTMLInputElement).value;
  try {
    unwatch = await watch(path, (event: WatchEvent) => {
      const line = `[${new Date().toISOString()}] ${JSON.stringify(event)}`;
      out.textContent = (line + '\n' + out.textContent).slice(0, 4000);
      // Events imply state changed — refresh the tree immediately.
      refreshTree(path);
    }, { recursive: false, delayMs: 200 });
    out.textContent = `watching ${path}…`;
    ($('btn-watch') as HTMLButtonElement).disabled = true;
    ($('btn-unwatch') as HTMLButtonElement).disabled = false;
    // Initial listing + slow poll as safety net against missed events.
    await refreshTree(path);
    treePollTimer = window.setInterval(() => refreshTree(path), 1500);
  } catch (e) {
    out.textContent = `ERR: ${String(e)}`;
  }
});
$('btn-unwatch').addEventListener('click', async () => {
  if (unwatch) await unwatch();
  unwatch = null;
  if (treePollTimer != null) { clearInterval(treePollTimer); treePollTimer = null; }
  ($('btn-watch') as HTMLButtonElement).disabled = false;
  ($('btn-unwatch') as HTMLButtonElement).disabled = true;
  $('out-watch').textContent += '\nstopped.';
});

// 4. Notifications plugin.
$('btn-notify').addEventListener('click', async () => {
  const out = $<HTMLPreElement>('out-notify');
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (!granted) {
      out.textContent = 'permission denied';
      return;
    }
    await sendNotification({
      title: 'browser-proxy',
      body: `hello from the browser tab at ${new Date().toLocaleTimeString()}`,
    });
    out.textContent = 'sent.';
  } catch (e) {
    out.textContent = `ERR: ${String(e)}`;
  }
});

// 5. Custom event roundtrip. Tauri side listens for 'ping', emits 'pong'.
// Verifies emit → Rust → emit → SSE → listen works end-to-end.
$('btn-ping').addEventListener('click', async () => {
  const out = $<HTMLPreElement>('out-ping');
  out.textContent = 'sending ping…';
  const start = performance.now();
  const un = await listen<string>('pong', (evt) => {
    const ms = (performance.now() - start).toFixed(1);
    out.textContent = `got pong: ${JSON.stringify(evt.payload)} in ${ms}ms`;
    un();
  });
  await emit('ping', { greeting: 'hi', sentAt: Date.now() });
});
