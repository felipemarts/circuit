#!/usr/bin/env node
// Solver performance bench: DC operating point + transient on generated RC
// ladders (and a diode-loaded variant) of ~50/200/500 nodes. Bundles the
// engine from src/ on the fly (esbuild, a devDependency), so no build step.
//
//   npm run perf              # default sizes 50,200,500
//   node scripts/perf.mjs 100 300
//
// For each size it reports wall time of the DC solve, of a fixed-step
// transient (1000 steps) and of an adaptive one, plus the share of the
// fixed-step transient spent inside the dense LU factorization (measured
// with the solver's opt-in profiler), which is what decides whether a
// sparse LU pays off.
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'circuitsvibe-perf-'));
const outfile = path.join(outdir, 'engine.mjs');
fs.writeFileSync(
  path.join(outdir, 'entry.ts'),
  `export * from ${JSON.stringify(path.join(root, 'src/forge.ts').replace(/\\/g, '/'))};\nexport { luSolveInPlace, luProfile } from ${JSON.stringify(path.join(root, 'src/solver/LUSolver.ts').replace(/\\/g, '/'))};\n`,
);
await build({ entryPoints: [path.join(outdir, 'entry.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
const E = await import(pathToFileURL(outfile).href);
fs.rmSync(outdir, { recursive: true, force: true });

const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const SIZES = sizes.length > 0 ? sizes : [50, 200, 500];

/** N-section RC ladder driven by a PULSE; every 10th node gets a diode to ground when `diodes`. */
function ladder(n, diodes) {
  const c = new E.Circuit();
  const v = new E.VoltageSource({ pulse: { v1: 0, v2: 1, td: '10u', tr: '1u', tf: '1u', pw: '200u', per: '1m' } });
  v.pin('-').connect(c.ground);
  let prev = v.pin('+');
  let lastCap;
  for (let i = 0; i < n; i++) {
    const r = new E.Resistor(100);
    const cap = new E.Capacitor('1n');
    prev.connect(r.pin('1'));
    r.pin('2').connect(cap.pin('1'));
    cap.pin('2').connect(c.ground);
    if (diodes && i % 10 === 9) {
      const d = new E.Diode();
      r.pin('2').connect(d.pin('anode'));
      d.pin('cathode').connect(c.ground);
    }
    prev = r.pin('2');
    lastCap = cap;
  }
  return { circuit: c, probe: { label: 'out', color: '', component: lastCap, type: 'voltage' } };
}

function time(fn) {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
}

const rows = [];
for (const n of SIZES) {
  for (const diodes of [false, true]) {
    const { circuit, probe } = ladder(n, diodes);
    // warm-up (JIT)
    circuit.analyze('dc');
    const dc = time(() => circuit.analyze('dc'));
    E.luProfile.enabled = true;
    E.luProfile.ms = 0;
    E.luProfile.calls = 0;
    const fixed = time(() => circuit.analyze('transient', { timeStep: 1e-6, duration: 1e-3 }, [probe]));
    E.luProfile.enabled = false;
    const luMs = E.luProfile.ms;
    const adaptive = time(() => circuit.analyze('transient', { timeStep: 1e-7, maxStep: 2e-5, duration: 1e-3, adaptive: true }, [probe]));
    const size = dc.r.solution.length;
    const solves = fixed.r.telemetry.newtonIterations;
    rows.push({
      circuit: `${diodes ? 'RC+diode' : 'RC'} ladder`,
      nodes: n,
      unknowns: size,
      dcMs: dc.ms.toFixed(1),
      tranFixedMs: fixed.ms.toFixed(0),
      fixedSolves: solves,
      luShare: `${((100 * luMs) / fixed.ms).toFixed(0)}%`,
      tranAdaptiveMs: adaptive.ms.toFixed(0),
      adaptiveSteps: adaptive.r.telemetry.acceptedSteps,
    });
  }
}
console.table(rows);
console.log(`node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown cpu'}`);
