import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: /smoke\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Tauri app is a shared resource.
  reporter: [['list']],
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Give localhost a generous handshake window.
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  // Spin up the Tauri dev stack for tests. Assumes `pnpm tauri dev` from the
  // example actually boots both Vite (on 5173) and the Tauri binary (which
  // starts the proxy on 1421).
  webServer: {
    command: 'pnpm --filter browser-proxy-example tauri dev',
    url: 'http://127.0.0.1:1421/health',
    timeout: 180_000,
    reuseExistingServer: !process.env['CI'],
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
