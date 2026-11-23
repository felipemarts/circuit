#!/usr/bin/env node
// Development launcher: bundles src/cli/entry.ts on the fly with esbuild (a
// devDependency) and runs it, so the CLI can be used from a checkout without
// a build step. The published package ships dist/circuitsvibe-standalone.mjs
// instead and needs neither esbuild nor src/.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'cli', 'entry.ts');

let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  console.error('error: esbuild not found — install project dependencies first (npm install)');
  process.exit(3);
}

const outdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'circuitsvibe-cli-'));
const outfile = path.join(outdir, 'cli.mjs');
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  loader: { '.md': 'text' },
  banner: { js: `import { createRequire as __cvCreateRequire } from 'node:module';\nconst require = __cvCreateRequire(import.meta.url);` },
  outfile,
  logLevel: 'silent',
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  // The module is fully loaded once import() resolves; main() keeps running.
  fs.rmSync(outdir, { recursive: true, force: true });
}
