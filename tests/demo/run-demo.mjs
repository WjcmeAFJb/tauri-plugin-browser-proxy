#!/usr/bin/env node
// Record a video of the browser-proxy demo.
//
// This script:
//   1. Creates /tmp/browser-proxy-demo with a handful of seed files.
//   2. Launches Playwright's Chromium headless (with recordVideo), navigates
//      to the Vite dev server, clicks through the example UI.
//   3. While the watcher is active, externally mutates files in the demo
//      directory — create, modify, delete — so you can see the fs events
//      stream into the browser tab.
//   4. Writes the recorded video to tests/demo/browser-proxy-demo.webm
//      and (if ffmpeg is present) transcodes it to .mp4.
//
// Prereqs: the Tauri binary is running and the proxy is listening on 1421;
// Vite is running on 5174. `tests/demo/boot-full-stack.sh` starts both.

import { chromium } from 'playwright';
import { writeFileSync, appendFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEMO_DIR = '/tmp/browser-proxy-demo';
const OUT_DIR = fileURLToPath(new URL('.', import.meta.url));
const VIDEO_DIR = join(OUT_DIR, 'video');
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5174';

// ---------- demo directory ----------
function resetDir() {
  if (existsSync(DEMO_DIR)) rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true });
  writeFileSync(join(DEMO_DIR, 'README.txt'), 'initial file\n');
  writeFileSync(join(DEMO_DIR, 'data.bin'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 0xff, 0xde, 0xad, 0xbe, 0xef]));
  writeFileSync(join(DEMO_DIR, 'notes.md'), '# notes\n\n- first\n- second\n');
}

resetDir();

// ---------- browser ----------
if (existsSync(VIDEO_DIR)) rmSync(VIDEO_DIR, { recursive: true, force: true });
mkdirSync(VIDEO_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 900 } },
  viewport: { width: 1280, height: 900 },
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
page.on('console', (m) => console.log(`[page:${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[page:error]', e.message));

async function tick(ms) { await page.waitForTimeout(ms); }

async function header(text) {
  await page.evaluate((t) => {
    let el = document.querySelector('#demo-header');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-header';
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;padding:8px 16px;background:#0b79ef;color:#fff;' +
        'font:600 14px/1.4 ui-monospace,monospace;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

console.log(`→ navigating to ${APP_URL}`);
// `networkidle` never fires here — the SSE /events connection stays open
// for the life of the page. Use `domcontentloaded` and gate on the status
// banner below instead.
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

await header('1/6  connecting to Tauri proxy on :1421');
await page.waitForSelector('[data-testid=proxy-status].ok', { timeout: 30_000 });
await tick(1500);

// ---------- 1. greet roundtrip ----------
await header('2/6  invoke(\'greet\', { name: \'world\' })');
await page.getByTestId('btn-greet').click();
await page.waitForFunction(
  () => (document.querySelector('[data-testid=out-greet]')?.textContent ?? '').includes('Hello'),
  { timeout: 10_000 }
);
await tick(1500);

// ---------- 2. read bytes ----------
await header('3/6  fs.readFile(\'/tmp/browser-proxy-demo/data.bin\') → Uint8Array');
await page.getByTestId('in-path').fill(join(DEMO_DIR, 'data.bin'));
await page.getByTestId('btn-read-bytes').click();
await page.waitForFunction(
  () => (document.querySelector('[data-testid=out-read-bytes]')?.textContent ?? '').includes('Uint8Array'),
  { timeout: 10_000 }
);
await tick(2000);

// ---------- 3. watch → external mutations ----------
await header('4/6  fs.watch() — external mutations will stream in as events');
await page.getByTestId('in-watch-path').fill(DEMO_DIR);
await page.getByTestId('btn-watch').click();
await tick(2500);
// Confirm the watcher actually started — on failure, dump the error and
// page state so the demo recorder has an actionable message.
const watchMsg = await page.getByTestId('out-watch').textContent();
if (!watchMsg || !watchMsg.includes('watching')) {
  console.error('watch failed to start — out-watch says:', JSON.stringify(watchMsg));
  await page.screenshot({ path: '/tmp/demo-watch-failed.png' });
  throw new Error(`fs.watch did not start: ${watchMsg}`);
}

async function externalMutation(label, fn) {
  await header(`4/6  fs.watch — ${label}`);
  fn();
  // Watcher events are asynchronous; give them time to propagate through
  // Rust → plugin → SSE → browser → UI render.
  await tick(1800);
}

await externalMutation('creating hello.txt', () => {
  writeFileSync(join(DEMO_DIR, 'hello.txt'), 'hello from the outside world\n');
});
await externalMutation('appending to hello.txt', () => {
  appendFileSync(join(DEMO_DIR, 'hello.txt'), 'another line\n');
});
await externalMutation('writing binary snapshot.dat', () => {
  const buf = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) buf[i] = i;
  writeFileSync(join(DEMO_DIR, 'snapshot.dat'), buf);
});
await externalMutation('overwriting notes.md', () => {
  writeFileSync(join(DEMO_DIR, 'notes.md'), '# notes (updated)\n\nall new content\n');
});
await externalMutation('deleting README.txt', () => {
  unlinkSync(join(DEMO_DIR, 'README.txt'));
});

// ---------- 4. stop watcher ----------
// Before stopping, assert the watch panel saw real events — otherwise the
// recording is misleading.
const watchText = (await page.getByTestId('out-watch').textContent()) ?? '';
const eventLines = watchText.split('\n').filter((l) => l.includes('"type"') || l.includes('"paths"'));
console.log(`→ watch panel captured ${eventLines.length} event line(s)`);
if (eventLines.length === 0) {
  await page.screenshot({ path: '/tmp/demo-no-events.png' });
  throw new Error('no watch events reached the browser panel — bridge not forwarding channel messages');
}
await header('5/6  stopping watcher');
await page.getByTestId('btn-unwatch').click();
await tick(1200);

// ---------- 5. custom ping/pong ----------
await header('6/6  emit(\'ping\') → Rust listens → emit(\'pong\') → browser listens');
await page.getByTestId('btn-ping').click();
await page.waitForFunction(
  () => (document.querySelector('[data-testid=out-ping]')?.textContent ?? '').includes('got pong'),
  { timeout: 10_000 }
);
await tick(2000);

await header('✓ demo complete — every invoke ran in Tauri, every event came through SSE');
await tick(1800);

await page.close();
await ctx.close();
await browser.close();

console.log('→ recording complete');

// Playwright names the video with a random file name inside VIDEO_DIR;
// find it and copy to a predictable name.
import { readdirSync, renameSync, statSync } from 'node:fs';
const videoFiles = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'));
if (videoFiles.length === 0) {
  console.error('no video produced');
  process.exit(1);
}
const src = join(VIDEO_DIR, videoFiles[0]);
const webm = join(OUT_DIR, 'browser-proxy-demo.webm');
renameSync(src, webm);
console.log(`→ video written to ${webm} (${(statSync(webm).size / 1024 / 1024).toFixed(2)} MB)`);

// Also extract key frames so reviewers can scrub without a video player.
const frames = join(OUT_DIR, 'frames');
if (existsSync(frames)) rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const extract = spawn('ffmpeg', [
  '-y', '-i', webm,
  '-vf', 'fps=1',
  '-q:v', '2',
  join(frames, 'frame-%02d.jpg'),
], { stdio: ['ignore', 'pipe', 'pipe'] });
extract.on('close', (code) => {
  if (code === 0) {
    const n = readdirSync(frames).length;
    console.log(`→ extracted ${n} key frames to ${frames}/`);
  } else {
    console.log('→ frame extraction skipped/failed');
  }
});

// Optional: transcode to mp4. Try encoders in order of availability.
const encoders = ['mpeg4', 'libxvid', 'libvpx-vp9'];
function tryEncode(i) {
  if (i >= encoders.length) {
    console.log('→ no mp4 encoder worked — webm at', webm, 'is the deliverable');
    return;
  }
  const mp4 = join(OUT_DIR, 'browser-proxy-demo.mp4');
  const p = spawn('ffmpeg', [
    '-y', '-i', webm,
    '-c:v', encoders[i],
    '-b:v', '1500k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  p.on('close', (code) => {
    if (code === 0) {
      console.log(`→ also wrote ${mp4} (encoder=${encoders[i]})`);
    } else {
      tryEncode(i + 1);
    }
  });
}
tryEncode(0);
