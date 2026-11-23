#!/usr/bin/env node
// Copies agent-facing files to the website root after `vite build`:
//   /circuitsvibe-standalone.mjs  single-file CLI for offline/sandboxed agents
//   /AGENTS.md                    the agent playbook (linked from /llms.txt)
// /llms.txt itself lives in public/ and is copied by vite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-site');
const standalone = path.join(root, 'dist', 'circuitsvibe-standalone.mjs');

if (!fs.existsSync(standalone)) {
  console.error('error: dist/circuitsvibe-standalone.mjs missing — run `npm run build:lib` first');
  process.exit(1);
}
fs.copyFileSync(standalone, path.join(out, 'circuitsvibe-standalone.mjs'));
fs.copyFileSync(path.join(root, 'AGENTS.md'), path.join(out, 'AGENTS.md'));
console.log('dist-site: + circuitsvibe-standalone.mjs, AGENTS.md');
