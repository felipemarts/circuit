#!/usr/bin/env node
// Builds the publishable package into dist/:
//   dist/index.js                      library (ESM, browser-safe, zero deps)
//   dist/types/                        .d.ts for the library (tsc)
//   dist/circuitsvibe-standalone.mjs   the CLI: one file, zero dependencies —
//                                      also the package `bin`
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(dist, { recursive: true, force: true });

const license = `/*! ${pkg.name} v${pkg.version} | MIT License | ${pkg.homepage} */`;

await build({
  entryPoints: [path.join(root, 'src/forge.ts')],
  outfile: path.join(dist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  // sucrase (firmware transpilation, src/mcu/firmware.ts) is a CommonJS package.
  mainFields: ['module', 'main'],
  target: 'es2022',
  sourcemap: true,
  banner: { js: license },
  logLevel: 'warning',
});

// `circuitsvibe/arduino`: the firmware API, so editors type-check firmware files
// (inside the simulator the import is mapped to the running MCU instead).
await build({
  entryPoints: [path.join(root, 'src/mcu/arduino.ts')],
  outfile: path.join(dist, 'arduino.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  banner: { js: license },
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(root, 'src/cli/entry.ts')],
  outfile: path.join(dist, 'circuitsvibe-standalone.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  loader: { '.md': 'text' },
  // Small enough to hand to an agent as an attachment; keepNames preserves
  // class names in error messages and stack traces.
  minify: true,
  keepNames: true,
  // Bundled CommonJS deps (sucrase) may call require() for Node builtins.
  banner: {
    js: `#!/usr/bin/env node\n${license}\nimport { createRequire as __cvCreateRequire } from 'node:module';\nconst require = __cvCreateRequire(import.meta.url);`,
  },
  legalComments: 'eof',
  logLevel: 'warning',
});

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.lib.json')], { stdio: 'inherit' });
addDeclarationExtensions(path.join(dist, 'types'));

/**
 * The sources use extensionless relative imports (bundler resolution), which
 * consumers on `moduleResolution: node16/nodenext` reject in .d.ts files.
 * Rewrite every relative specifier to the explicit `.js` path it maps to.
 */
function addDeclarationExtensions(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.d.ts'));
  for (const rel of files) {
    const file = path.join(dir, rel);
    const text = fs.readFileSync(file, 'utf8');
    const fixed = text.replace(/((?:from|import)\s*\(?\s*)(['"])(\.\.?(?:\/[^'"]*)?)\2/g, (m, lead, q, spec) => {
      if (/\.(m|c)?js$/.test(spec)) return m;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(`${target}.d.ts`)) return `${lead}${q}${spec}.js${q}`;
      if (fs.existsSync(path.join(target, 'index.d.ts'))) return `${lead}${q}${spec}/index.js${q}`;
      throw new Error(`cannot map declaration import '${spec}' in ${rel}`);
    });
    if (fixed !== text) fs.writeFileSync(file, fixed);
  }
}

for (const f of ['index.js', 'arduino.js', 'circuitsvibe-standalone.mjs']) {
  const kb = (fs.statSync(path.join(dist, f)).size / 1024).toFixed(0);
  console.log(`dist/${f}  ${kb} KiB`);
}
