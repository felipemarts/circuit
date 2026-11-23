import * as fs from 'node:fs';
import * as path from 'node:path';
import AGENTS_MD from '../../AGENTS.md';
import { CLI, PACKAGE_NAME } from '../schema/version';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Starter bench: passes as written, so the first `verify` is green. */
export function benchTemplate(name: string): string {
  return `import { bench, VoltageSource, Resistor, LED } from '${PACKAGE_NAME}';

/**
 * ${name}: 5 V supply → series resistor → LED → ground.
 * Verify:   npx ${CLI} verify ${name}.bench.ts --json
 * Playbook: npx ${CLI} agents   (also in AGENTS.md)
 */
export default bench('${name}', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.name('led', d1.pin('anode'));

  // Free parameter: on a failed op assertion the platform sweeps this range
  // and returns a simulation-verified value instead of making you guess.
  tb.param('R1', { min: '100', max: '10k', scale: 'log' });

  tb.expect.op('D1.i').toBeWithin('5m', '15m'); // LED bright but safe
  tb.expect.op('led').toBeWithin(1.8, 2.6);     // sane forward voltage
});
`;
}

/**
 * `init [name]`: scaffold <name>.bench.ts and AGENTS.md in the working
 * directory. Never overwrites a bench without --force, and never touches an
 * existing AGENTS.md (it may hold the project's own agent instructions).
 */
export function init(rawName: string | undefined, opts: { force: boolean }, cwd = process.cwd()): number {
  const name = (rawName ?? 'circuit').replace(/\.bench\.ts$/, '');
  if (!NAME_RE.test(name)) {
    console.error(
      `error: invalid bench name '${rawName}': use letters, digits, '-' or '_' (e.g. ${CLI} init led-driver)`,
    );
    return 3;
  }

  const benchFile = `${name}.bench.ts`;
  const benchPath = path.join(cwd, benchFile);
  if (fs.existsSync(benchPath) && !opts.force) {
    console.error(`error: ${benchFile} already exists — pick another name or pass --force to overwrite it`);
    return 3;
  }
  fs.writeFileSync(benchPath, benchTemplate(name));
  const created = [benchFile];

  const agentsPath = path.join(cwd, 'AGENTS.md');
  let agentsNote = '';
  if (fs.existsSync(agentsPath)) {
    agentsNote = `\nAGENTS.md already exists and was left untouched — append the playbook with:\n  npx ${CLI} agents >> AGENTS.md\n`;
  } else {
    fs.writeFileSync(agentsPath, AGENTS_MD);
    created.push('AGENTS.md');
  }

  console.log(`created ${created.join(', ')}
${agentsNote}
next:
  npx ${CLI} verify ${benchFile}          # human-readable
  npx ${CLI} verify ${benchFile} --json   # full RunRecord for agents`);
  return 0;
}
