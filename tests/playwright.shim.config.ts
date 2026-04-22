import { defineConfig, devices } from '@playwright/test';

// Config for the unit-style shim tests. Does not need a real Tauri binary,
// since each test spins up its own mock server. CI can run this on any
// machine with a browser install.
export default defineConfig({
  testDir: './specs',
  testMatch: /shim-.*\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['list']],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
