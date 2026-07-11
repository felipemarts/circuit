import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Library build — emits the publishable `circuit-forge` package entry.
// Kept separate from the web-app build (see vite.config.ts, which builds the
// multi-page site into dist-app/). This one bundles the browser-safe library
// surface (src/forge.ts) into dist/ as ESM. Type declarations are produced
// alongside by `tsc -p tsconfig.lib.json` (see the build:lib script).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/forge.ts'),
      formats: ['es'],
      fileName: () => 'forge.js',
    },
    rollupOptions: {
      // The library surface has no runtime dependencies — bundle everything.
      external: [],
    },
  },
});
