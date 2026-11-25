#!/usr/bin/env node
// Refreshes every "Open in viewer" link of the website from the benches it
// points at. An anchor that carries data-bench="bench/x.bench.ts" gets its
// href replaced by the share link of that bench (`circuitsvibe share`), so the
// links on the landing and in the docs always match the committed bench code.
//
//   node scripts/share-links.mjs                 # index*.html + docs*.html
//   node scripts/share-links.mjs --check         # fail if any link is stale
//   node scripts/share-links.mjs file.html …     # specific pages
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const pages = args.filter(a => !a.startsWith('--'));
const files = (pages.length ? pages : ['index.html', 'index.pt.html', 'docs.html', 'docs.pt.html']).map(f => path.resolve(root, f));

const cache = new Map();
function shareUrl(bench) {
  if (cache.has(bench)) return cache.get(bench);
  const file = path.join(root, bench);
  if (!fs.existsSync(file)) throw new Error(`data-bench points at a missing file: ${bench}`);
  const r = spawnSync(process.execPath, [path.join(root, 'bin/dev.mjs'), 'share', bench, '--json', '--base-url', 'app.html'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`share failed for ${bench}:\n${r.stderr}`);
  const url = JSON.parse(r.stdout).url;
  cache.set(bench, url);
  return url;
}

let stale = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  // href and data-bench may come in either order inside the <a …> tag.
  const after = before.replace(/<a\b[^>]*\bdata-bench="([^"]+)"[^>]*>/g, tag => {
    const bench = tag.match(/\bdata-bench="([^"]+)"/)[1];
    const url = shareUrl(bench);
    if (!/\bhref="/.test(tag)) return tag.replace(/<a\b/, `<a href="${url}"`);
    return tag.replace(/\bhref="[^"]*"/, `href="${url}"`);
  });
  const n = (before.match(/\bdata-bench="/g) ?? []).length;
  if (after !== before) {
    stale++;
    if (!check) fs.writeFileSync(file, after);
  }
  console.log(`${path.relative(root, file)}: ${n} viewer link${n === 1 ? '' : 's'}${after !== before ? (check ? ' — STALE' : ' — updated') : ' — up to date'}`);
}
if (check && stale) {
  console.error(`error: ${stale} page(s) have stale share links — run node scripts/share-links.mjs`);
  process.exit(1);
}
