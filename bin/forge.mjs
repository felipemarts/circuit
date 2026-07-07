#!/usr/bin/env node
// forge CLI bootstrap: bundles src/cli/main.ts with the project's esbuild and
// runs it. Keeps the repo dependency-free at runtime while letting the CLI be
// written in TypeScript. Inline sourcemaps + setSourceMapsEnabled give every
// diagnostic real .ts file:line locations.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.setSourceMapsEnabled(true);

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'cli', 'main.ts');

let build;
try {
  ({ build } = await import('esbuild'));
} catch {
  console.error('error: esbuild not found — install project dependencies first (npm install)');
  process.exit(3);
}

const outdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-cli-'));
const outfile = path.join(outdir, 'main.mjs');
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  sourcemap: 'inline',
  outfile,
  logLevel: 'silent',
});

let code;
try {
  const mod = await import(pathToFileURL(outfile).href);
  code = await mod.main(process.argv.slice(2));
} finally {
  fs.rmSync(outdir, { recursive: true, force: true });
}
process.exit(code);
