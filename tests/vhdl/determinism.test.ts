import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DigitalCircuit, DigitalSim, Clock, Stimulus, toVCD } from '../../src/digital';
import { compileVhdl } from '../../src/vhdl';
import { design } from './helpers';

// Same VHDL + same stimuli ⇒ byte-identical netlist, waveforms and diagnostics;
// the netlist is plain JSON and rebuilds the identical simulation.

const read = (n: string): string => fs.readFileSync(path.join('tests', 'vhdl', 'designs', n), 'utf8');

function run(order: 'a' | 'b') {
  const d = design([read('uart_tx.vhd'), read('counter.vhd')]);
  const c = new DigitalCircuit();
  const add = () => {
    c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
    c.add('SG', new Stimulus({ changes: [['25n', 1], ['35n', 0]] }), { y: 'GO' });
    c.add('SD', new Stimulus({ initial: 1 }), { y: 'D[0]' });
    c.add('SR', new Stimulus({ initial: 0 }), { y: 'RST' });
  };
  const inst = () => {
    d.instantiate(c, 'TX', { entity: 'uart_tx', ports: { clk: 'CLK', rst: 'RST', start: 'GO', data: ['D[0]', 'D[0]', 'D[0]', 'D[0]', 'D[0]', 'D[0]', 'D[0]', 'D[0]'].map((n, i) => (i === 0 ? n : `D${i}`)) } });
    d.instantiate(c, 'CNT', { entity: 'counter', generics: { N: 3 }, ports: { clk: 'CLK', rst: 'RST', q: 'Q' } });
  };
  if (order === 'a') {
    add();
    inst();
  } else {
    inst();
    add();
  }
  const net = c.netlist();
  const sim = c.build();
  sim.advanceTo('800n');
  return { net, sim };
}

describe('determinism', () => {
  it('compiling twice gives identical diagnostics and netlists, independent of build order', () => {
    const a = run('a');
    const b = run('b');
    expect(JSON.stringify(b.net)).toBe(JSON.stringify(a.net));
    expect(toVCD(b.sim.recording())).toBe(toVCD(a.sim.recording()));
    expect(JSON.stringify(b.sim.diagnostics())).toBe(JSON.stringify(a.sim.diagnostics()));
    const src = `${read('counter.vhd')}\nentity bad is end; architecture r of bad is begin x <= '1'; end;`;
    expect(JSON.stringify(compileVhdl(src, { origin: 'o' }).diagnostics)).toBe(JSON.stringify(compileVhdl(src, { origin: 'o' }).diagnostics));
  });

  it('the netlist is plain JSON: DigitalSim(JSON.parse(JSON.stringify(netlist))) reproduces the waveforms', () => {
    const a = run('a');
    const rebuilt = new DigitalSim(JSON.parse(JSON.stringify(a.net)));
    rebuilt.advanceTo('800n');
    expect(toVCD(rebuilt.recording())).toBe(toVCD(a.sim.recording()));
    expect(DigitalCircuit.fromJSON(JSON.parse(JSON.stringify(a.net))).netlist()).toEqual(a.net);
  });
});
