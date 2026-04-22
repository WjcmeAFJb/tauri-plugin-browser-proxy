import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src-js/index.ts',
      shim: 'src-js/shim.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'es2020',
    // The shim has to be usable as a plain import in browser code.
    splitting: false,
    platform: 'browser',
  },
  {
    entry: { vite: 'vite/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'node18',
    platform: 'node',
  },
]);
