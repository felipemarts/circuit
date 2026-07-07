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

const { build } = await import('esbuild');
const outfile = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-cli-')), 'main.mjs');
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

const mod = await import(pathToFileURL(outfile).href);
const code = await mod.main(process.argv.slice(2));
process.exit(code);
