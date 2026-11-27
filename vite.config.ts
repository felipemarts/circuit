import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The website (landing, docs, simulator) builds into dist-site/; dist/ is
// reserved for the npm package (see scripts/build.mjs).
export default defineConfig({
  build: {
    outDir: 'dist-site',
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        docs: resolve(__dirname, 'docs.html'),
        landingPt: resolve(__dirname, 'index.pt.html'),
        appPt: resolve(__dirname, 'app.pt.html'),
        docsPt: resolve(__dirname, 'docs.pt.html'),
        wall: resolve(__dirname, 'wall.html'),
        wallPt: resolve(__dirname, 'wall.pt.html'),
      },
    },
  },
});
