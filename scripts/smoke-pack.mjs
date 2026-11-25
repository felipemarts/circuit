#!/usr/bin/env node
// Proves the publishable artifact works outside this repo:
//   1. `npm pack` (prepack builds dist/) and check the tarball's file list;
//   2. empty folder: `npx --package=<tarball> circuitsvibe init` + `verify`
//      (what `npx circuitsvibe …` does once published) — also the `cvibe` alias;
//   3. a project that installs the tarball: import the library, run the
//      ladder, and typecheck against the shipped .d.ts;
//   4. the standalone file alone in a folder with no node_modules;
//   5. share links: share → open round trip, export → verify <doc.json>,
//      verify --share (from the tarball and from the standalone file).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'circuitsvibe-smoke-'));
const isWin = process.platform === 'win32';

function sh(cmd, args, cwd, { expect = 0 } = {}) {
  // npm/npx are .cmd shims on Windows and need a shell there.
  const quoted = isWin ? args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : args;
  const r = spawnSync(cmd, quoted, { cwd, encoding: 'utf8', shell: isWin, env: { ...process.env, npm_config_yes: 'true' } });
  if (r.status !== expect) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` in ${cwd} exited ${r.status} (expected ${expect})\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  fn();
  console.log('ok');
}

try {
  let tarball;
  step('npm pack', () => {
    // Build explicitly: prepack's build log would otherwise pollute --json.
    sh('npm', ['run', 'build:lib', '--silent'], root);
    const out = JSON.parse(sh('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], root));
    tarball = path.join(work, out[0].filename);
    const files = out[0].files.map((f) => f.path).sort();
    const required = [
      'package.json',
      'LICENSE',
      'README.md',
      'AGENTS.md',
      'skills/circuitsvibe/SKILL.md',
      'dist/index.js',
      'dist/types/forge.d.ts',
      'dist/circuitsvibe-standalone.mjs',
      'schema/circuit.schema.json',
    ];
    for (const f of required) if (!files.includes(f)) throw new Error(`tarball is missing ${f}`);
    const leaked = files.filter((f) => /^(src|tests|bench|bin|scripts)\//.test(f));
    if (leaked.length) throw new Error(`tarball ships source files: ${leaked.join(', ')}`);
    const kb = (out[0].size / 1024).toFixed(0);
    process.stdout.write(`${files.length} files, ${kb} KiB packed … `);
  });

  const empty = path.join(work, 'empty');
  fs.mkdirSync(empty);
  step('npx init + verify in an empty folder', () => {
    sh('npx', ['--yes', `--package=${tarball}`, 'circuitsvibe', 'init', 'demo'], empty);
    const record = JSON.parse(
      sh('npx', ['--yes', `--package=${tarball}`, 'circuitsvibe', 'verify', 'demo.bench.ts', '--json'], empty),
    );
    if (record.verdict !== 'pass') throw new Error(`demo bench verdict ${record.verdict}`);
    if (!fs.existsSync(path.join(empty, 'AGENTS.md'))) throw new Error('init did not write AGENTS.md');
    if (!fs.existsSync(path.join(empty, '.circuitsvibe', 'runs.jsonl'))) throw new Error('no ledger written');
  });

  step('cvibe alias + failing bench exits 1 with a verified hint', () => {
    const bench = fs
      .readFileSync(path.join(empty, 'demo.bench.ts'), 'utf8')
      .replace("new Resistor('330')", "new Resistor('100')")
      .replace("toBeWithin('5m', '15m')", "toBeWithin('8m', '12m')");
    fs.writeFileSync(path.join(empty, 'hot.bench.ts'), bench);
    const out = sh('npx', ['--yes', `--package=${tarball}`, 'cvibe', 'verify', 'hot.bench.ts', '--json'], empty, {
      expect: 1,
    });
    const hint = JSON.parse(out).stages.op.assertions.find((a) => a.verdict === 'fail').hint;
    if (hint?.kind !== 'verified-param-range') throw new Error('missing verified hint');
  });

  step('share → open, export → verify <doc.json>, verify --share (npx)', () => {
    const npx = (...args) => ['--yes', `--package=${tarball}`, 'circuitsvibe', ...args];
    const url = sh('npx', npx('share', 'demo.bench.ts', '--title', 'smoke'), empty).trim();
    if (!/^https:\/\/circuitsvibe\.com\/app\.html#c=1\.[A-Za-z0-9_-]+$/.test(url)) throw new Error(`unexpected share URL: ${url}`);
    const doc = JSON.parse(sh('npx', npx('open', url), empty));
    if (doc.schema !== 'circuitsvibe-circuit/1' || doc.name !== 'demo' || doc.meta?.title !== 'smoke') throw new Error('open did not return the shared document');
    sh('npx', npx('export', 'demo.bench.ts', '-o', 'demo.circuit.json'), empty);
    const fromDoc = sh('npx', npx('verify', 'demo.circuit.json', '--json', '--no-ledger'), empty);
    const fromBench = sh('npx', npx('verify', 'demo.bench.ts', '--json', '--no-ledger'), empty);
    if (fromDoc !== fromBench) throw new Error('verify of the exported document differs from the bench');
    const record = JSON.parse(sh('npx', npx('verify', 'demo.bench.ts', '--json', '--no-ledger', '--share'), empty));
    if (record.verdict !== 'pass' || !record.share?.url?.startsWith('https://circuitsvibe.com/app.html#c=1.')) {
      throw new Error('verify --share has no share.url');
    }
  });

  const project = path.join(work, 'project');
  fs.mkdirSync(project);
  step('install tarball, import the library, run the ladder', () => {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'p', private: true, type: 'module' }));
    sh('npm', ['install', '--no-audit', '--no-fund', tarball], project);
    if (fs.existsSync(path.join(project, 'node_modules', 'esbuild'))) throw new Error('esbuild was installed');
    fs.writeFileSync(
      path.join(project, 'run.mjs'),
      `import { bench, runLadder, VoltageSource, Resistor } from 'circuitsvibe';
const desc = bench('div', (tb) => {
  const v = tb.add('V1', new VoltageSource(10));
  const a = tb.add('R1', new Resistor('1k'));
  const b = tb.add('R2', new Resistor('1k'));
  v.pin('+').connect(a.pin('1')); a.pin('2').connect(b.pin('1'));
  b.pin('2').connect(tb.gnd); v.pin('-').connect(tb.gnd);
  tb.name('mid', a.pin('2'));
  tb.expect.op('mid').toBeCloseTo(5, 1e-9);
});
const r = runLadder(desc);
if (r.exitCode !== 0) { console.error(JSON.stringify(r)); process.exit(1); }
console.log('ok');
`,
    );
    sh('node', ['run.mjs'], project);
  });

  step('typecheck a bench against the shipped .d.ts', () => {
    fs.writeFileSync(
      path.join(project, 'typed.bench.ts'),
      `import { bench, Resistor, VoltageSource, type TB } from 'circuitsvibe';
export default bench('typed', (tb: TB) => {
  const r: Resistor = tb.add('R1', new Resistor('1k'));
  const v = tb.add('V1', new VoltageSource(1));
  v.pin('+').connect(r.pin('1'));
  tb.expect.op('R1.i').toBeAbove('1u');
});
`,
    );
    fs.writeFileSync(
      path.join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', types: [] },
        files: ['typed.bench.ts'],
      }),
    );
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    sh(process.execPath, [tsc, '-p', 'tsconfig.json'], project);
  });

  step('MCU bench from the tarball: firmware imports circuitsvibe/arduino (typed), verify, share → open → verify', () => {
    fs.writeFileSync(
      path.join(project, 'blink.fw.ts'),
      `import { pinMode, digitalWrite, delay, Serial, OUTPUT, HIGH, LOW, LED_BUILTIN } from 'circuitsvibe/arduino';
export async function setup(): Promise<void> {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println('up');
}
export async function loop(): Promise<void> {
  digitalWrite(LED_BUILTIN, HIGH);
  await delay(100);
  digitalWrite(LED_BUILTIN, LOW);
  await delay(100);
}
`,
    );
    fs.writeFileSync(
      path.join(project, 'uno.bench.ts'),
      `import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';
export default bench('uno', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  const run = tb.expect.tran({ tstop: '0.45', maxStep: '5m' });
  run.logic('U1.D13').toHaveFrequency(5, 1e-9, { from: '0.05' });
  run.serial('U1').toContain('up');
});
`,
    );
    // Editors type-check firmware through package.json#exports['./arduino'].
    fs.writeFileSync(
      path.join(project, 'tsconfig.fw.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', types: [] },
        files: ['blink.fw.ts', 'uno.bench.ts'],
      }),
    );
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    sh(process.execPath, [tsc, '-p', 'tsconfig.fw.json'], project);
    const npx = (...args) => ['--yes', `--package=${tarball}`, 'circuitsvibe', ...args];
    const record = JSON.parse(sh('npx', npx('verify', 'uno.bench.ts', '--json', '--no-ledger'), project));
    if (record.verdict !== 'pass' || record.stages.tran.serial?.[0]?.lines?.[0]?.[1] !== 'up') throw new Error(`MCU bench verdict ${record.verdict}`);
    const url = sh('npx', npx('share', 'uno.bench.ts'), project).trim();
    const doc = JSON.parse(sh('npx', npx('open', url), project));
    if (!doc.sources?.some((s) => s.path === 'blink.fw.ts' && s.text.includes("from 'circuitsvibe/arduino'"))) throw new Error('shared document does not embed the firmware');
    fs.writeFileSync(path.join(project, 'uno.circuit.json'), JSON.stringify(doc));
    const fromLink = JSON.parse(sh('npx', npx('verify', 'uno.circuit.json', '--json', '--no-ledger'), project));
    if (fromLink.verdict !== 'pass' || JSON.stringify(fromLink.stages.tran.assertions) !== JSON.stringify(record.stages.tran.assertions.map(({ at, ...a }) => a))) {
      throw new Error('verify of the shared MCU document differs from the bench');
    }
  });

  const offline = path.join(work, 'offline');
  fs.mkdirSync(offline);
  step('standalone file alone, no node_modules', () => {
    fs.copyFileSync(path.join(root, 'dist', 'circuitsvibe-standalone.mjs'), path.join(offline, 'circuitsvibe-standalone.mjs'));
    sh(process.execPath, ['circuitsvibe-standalone.mjs', 'init', 'solo'], offline);
    sh(process.execPath, ['circuitsvibe-standalone.mjs', 'verify', 'solo.bench.ts', '--no-ledger'], offline);
    sh(process.execPath, ['circuitsvibe-standalone.mjs', 'explain', 'F105'], offline);
    const url = sh(process.execPath, ['circuitsvibe-standalone.mjs', 'share', 'solo.bench.ts'], offline).trim();
    const doc = JSON.parse(sh(process.execPath, ['circuitsvibe-standalone.mjs', 'open', url], offline));
    if (doc.name !== 'solo') throw new Error('standalone open did not return the shared document');
    sh(process.execPath, ['circuitsvibe-standalone.mjs', 'open', '#c=1.garbage'], offline, { expect: 3 });
  });

  console.log(`\nsmoke test passed (node ${process.version})`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
