import { defineConfig } from 'vite';
import { browserProxy } from 'tauri-plugin-browser-proxy-js/vite';

// Tauri expects a fixed port & strictPort; 5173 is Vite's default.
export default defineConfig({
  plugins: [browserProxy({ port: 1421 })],
  server: {
    // 5173 is Vite's default but often claimed by another dev server.
    // 5174 is still within the plugin's default CORS allowlist (5170..5180).
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
  },
  // Load env vars prefixed with `VITE_` only.
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  clearScreen: false,
});
