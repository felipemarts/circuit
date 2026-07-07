import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { BenchDescriptor } from '../elab/bench';

const EXAMPLE = `a bench file looks like:

  import { bench, VoltageSource, Resistor, LED } from 'circuit-forge';

  export default bench('led-driver', (tb) => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor('330'));
    const d1 = tb.add('D1', new LED());
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.expect.op('D1.i').toBeWithin('5m', '15m');
  });`;

/**
 * Load a .bench.ts file: bundle it with the project's esbuild (resolved from
 * the working directory, so this works even when the CLI itself runs from a
 * temp bundle) and import the default-exported bench descriptor.
 */
export async function loadBench(file: string): Promise<BenchDescriptor> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`bench file not found: ${file}\n\n${EXAMPLE}`);
  }

  const requireFromCwd = createRequire(path.join(process.cwd(), 'noop.js'));
  let esbuild: typeof import('esbuild');
  try {
    esbuild = requireFromCwd('esbuild');
  } catch {
    throw new Error(
      `esbuild not found from ${process.cwd()} — run the forge CLI from a project with esbuild installed (npm i -D esbuild)`,
    );
  }

  const localForge = path.join(process.cwd(), 'src', 'forge.ts');
  // realpath matters on macOS: /var/folders is a symlink to /private/var, and
  // sourcemap-relative source paths only resolve correctly from the real path.
  const outdir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-bench-'));
  const outfile = path.join(outdir, 'bench.mjs');
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      sourcemap: 'inline',
      outfile,
      logLevel: 'silent',
      ...(fs.existsSync(localForge) ? { alias: { 'circuit-forge': localForge } } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to compile ${file}:\n${message}`);
  }

  const mod = (await import(pathToFileURL(outfile).href)) as { default?: unknown };
  const desc = mod.default as BenchDescriptor | undefined;
  if (!desc || typeof desc !== 'object' || typeof desc.name !== 'string' || typeof desc.build !== 'function') {
    throw new Error(`${file} must default-export a bench(...) descriptor\n\n${EXAMPLE}`);
  }
  return desc;
}
