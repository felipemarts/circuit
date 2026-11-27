#!/usr/bin/env node
// Copies agent-facing files to the website root after `vite build`:
//   /circuitsvibe-standalone.mjs  single-file CLI for offline/sandboxed agents
//   /AGENTS.md                    the agent playbook (linked from /llms.txt)
//   /api/                         the PHP + SQLite service (server/api; data/ ships empty, never a database)
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

// The API: every file of server/api except runtime data and local configuration.
const apiSrc = path.join(root, 'server', 'api');
const apiOut = path.join(out, 'api');
fs.rmSync(apiOut, { recursive: true, force: true });
fs.cpSync(apiSrc, apiOut, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(apiSrc, src).split(path.sep).join('/');
    if (rel === 'config.local.php') return false;
    if (rel.startsWith('data/')) return rel === 'data/.htaccess' || rel === 'data/.gitignore';
    return true;
  },
});
console.log('dist-site: + circuitsvibe-standalone.mjs, AGENTS.md, api/');
