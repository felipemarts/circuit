import { describe, it, expect } from 'vitest';
import { DigitalCircuit, DFF, Not, Clock, valueAt } from '../../src/digital';

describe('performance sanity', () => {
  it('1000-flip-flop shift chain, every stage toggling every cycle, 1000 clock cycles', () => {
    const N = 1000;
    const CYCLES = 1000;
    const t0 = performance.now();
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ freq: '100M' }), { y: 'clk' });
    // FF0 toggles (d = NOT q0) → a 0101… pattern marches down the chain: maximum activity.
    c.add('T0', new Not({ delay: '0.5n' }), { a: 'Q0', y: 'D0' });
    for (let i = 0; i < N; i++) {
      c.add(`FF${i}`, new DFF({ delay: '1n', setup: '0.2n', hold: '0.1n' }), { d: i === 0 ? 'D0' : `Q${i - 1}`, clk: 'clk', q: `Q${i}` });
    }
    const sim = c.build();
    const tBuilt = performance.now();
    sim.advanceTo(CYCLES * 10e-9);
    const tRun = performance.now();
    const stats = sim.stats();

    // Correctness: stage i follows stage 0 delayed by i cycles; after the pipeline fills, every stage toggles each cycle.
    const mid = sim.trace(`Q${N / 2 - 1}`);
    expect(valueAt(mid, 700 * 10e-9 + 2e-9)).not.toBe(valueAt(mid, 701 * 10e-9 + 2e-9));
    expect(sim.trace(`Q${N - 1}`).v).toEqual([0]); // the wavefront has not reached the end yet
    expect(sim.trace('Q0').t.length).toBe(CYCLES); // power-on + 999 toggles (the edge at 10 us lands its q after the end)
    expect(sim.diagnostics()).toEqual([]);
    expect(stats.evaluations).toBeGreaterThan(N * CYCLES);

    const build = tBuilt - t0;
    const run = tRun - tBuilt;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${N}-FF chain, ${CYCLES} cycles: build ${build.toFixed(0)} ms, run ${run.toFixed(0)} ms, ` +
        `${stats.events} events, ${stats.evaluations} evaluations (${((stats.events / run) * 1000 / 1e6).toFixed(2)} M events/s)`,
    );
    expect(build + run).toBeLessThan(20000); // sanity bound, not a benchmark
  }, 60000);
});
