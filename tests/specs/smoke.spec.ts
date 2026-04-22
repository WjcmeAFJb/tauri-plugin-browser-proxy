import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe('browser-proxy end-to-end', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Proxy health check — banner goes green once /proxy_url returns.
    await expect(page.getByTestId('proxy-status')).toContainText('connected', {
      timeout: 30_000,
    });
  });

  test('regular invoke roundtrip (greet)', async ({ page }) => {
    await page.getByTestId('btn-greet').click();
    await expect(page.getByTestId('out-greet')).toContainText('Hello, world!');
  });

  test('binary roundtrip (fs.readFile returns Uint8Array)', async ({ page }) => {
    // Prepare a file with a known byte pattern. We write 256 bytes covering
    // every value — any JSON-stringify-based transport would mangle the
    // high bits, so this is the canary.
    const dir = mkdtempSync(join(tmpdir(), 'browser-proxy-'));
    const path = join(dir, 'bytes.bin');
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    writeFileSync(path, bytes);

    await page.getByTestId('in-path').fill(path);
    await page.getByTestId('btn-read-bytes').click();

    const out = page.getByTestId('out-read-bytes');
    await expect(out).toContainText('type=Uint8Array');
    await expect(out).toContainText('len=256');
    // Spot-check: bytes 0x00..0x3F (first 64) should appear in hex output.
    await expect(out).toContainText('00 01 02 03 04 05 06 07');
    await expect(out).toContainText('38 39 3a 3b 3c 3d 3e 3f');
  });

  test('fs watcher events reach the browser tab', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-proxy-watch-'));
    await page.getByTestId('in-watch-path').fill(dir);
    await page.getByTestId('btn-watch').click();

    // Poke the directory — a new file should raise an event.
    const target = join(dir, 'poke.txt');
    // Give the watcher a moment to arm.
    await page.waitForTimeout(500);
    writeFileSync(target, 'hi');

    const out = page.getByTestId('out-watch');
    await expect(out).toContainText(/"paths"|poke\.txt|"type"/, {
      timeout: 10_000,
    });
  });

  test('custom emit → listen roundtrip (ping/pong)', async ({ page }) => {
    await page.getByTestId('btn-ping').click();
    await expect(page.getByTestId('out-ping')).toContainText('got pong', {
      timeout: 10_000,
    });
  });

  test('notification plugin does not throw', async ({ page }) => {
    // In headless chromium the actual OS notification may be suppressed,
    // but the invoke call should succeed.
    await page.getByTestId('btn-notify').click();
    // Either 'sent.' on success, or 'permission denied' on a locked-down CI.
    await expect(page.getByTestId('out-notify')).toContainText(
      /sent|permission denied/,
      { timeout: 10_000 },
    );
  });
});
