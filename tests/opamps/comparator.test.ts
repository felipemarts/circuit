import { describe, it, expect } from 'vitest';
import { bench, Comparator, Part, Resistor, Capacitor, VoltageSource, runLadder, type TB } from '../../src/forge';
import type { Component } from '../../src/core/Component';
import { op, supplies, tran, at, crossing } from './helpers';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** Comparator with VIN on `pin`, VREF on the other input, pull-up RP to VPU, optional CL. */
function stage(
  make: () => Component,
  o: { vin: number | object; vref: number; pin: 'inp' | 'inn'; rp: number; vpu: number; cl?: number; rails?: [number, number]; emitToGnd?: boolean },
) {
  return bench('comparator', (tb: TB) => {
    const u = tb.add('U1', make());
    const vi = tb.add('VI', new VoltageSource(o.vin as never));
    const vr = tb.add('VR', new VoltageSource(o.vref));
    const rp = tb.add('RP', new Resistor(o.rp));
    const vpu = tb.add('VPU', new VoltageSource(o.vpu));
    vi.pin('+').connect(u.pin(o.pin));
    vi.pin('-').connect(tb.gnd);
    vr.pin('+').connect(u.pin(o.pin === 'inp' ? 'inn' : 'inp'));
    vr.pin('-').connect(tb.gnd);
    vpu.pin('+').connect(rp.pin('1'));
    vpu.pin('-').connect(tb.gnd);
    rp.pin('2').connect(u.pin('out'));
    if (o.cl) {
      const cl = tb.add('CL', new Capacitor(o.cl));
      cl.pin('1').connect(u.pin('out'));
      cl.pin('2').connect(tb.gnd);
    }
    supplies(tb, u, ...(o.rails ?? [5, 0]));
    if (o.emitToGnd) u.pin('emit').connect(tb.gnd);
    tb.name('out', u.pin('out'));
  });
}

describe('Comparator (open collector)', () => {
  it('LM393 output low saturation: VOL = 0.13 V at 4 mA sink (data typ; ±5 mV), ≤ 0.4 V max', () => {
    const rp = (5 - 0.13) / 4e-3;
    const r = op(stage(() => Part('LM393'), { vin: 1, vref: 2, pin: 'inp', rp, vpu: 5 }));
    expect(Math.abs(r.v('out') - 0.13)).toBeLessThan(5e-3);
    const u = r.el.components.get('U1') as unknown as { current: number };
    expect(rel(-u.current, 4e-3)).toBeLessThan(0.01);
  });

  it('LM393 sinks at most its data sink current (6 mA min at VOL = 1.5 V) into a stiff pull-up', () => {
    const r = op(stage(() => Part('LM393'), { vin: 1, vref: 2, pin: 'inp', rp: 100, vpu: 5 }));
    const u = r.el.components.get('U1') as unknown as { current: number };
    expect(-u.current).toBeLessThanOrEqual(6e-3 * 1.0001); // + off-state leakage conductance
    expect(-u.current).toBeGreaterThan(5.9e-3);
  });

  it('open collector: the high level is the pull-up voltage, even above the comparator supply', () => {
    for (const vpu of [5, 12]) {
      const r = op(stage(() => Part('LM393'), { vin: 3, vref: 2, pin: 'inp', rp: 10e3, vpu }));
      // Off-state leakage gleak = 0.1 nA / 5 V (data) through 10 kΩ: microvolts.
      expect(Math.abs(r.v('out') - vpu)).toBeLessThan(1e-4);
    }
  });

  it('switches at V(inp) = V(inn) − Vos (DC sweep, LM393 Vos = 2 mV typ; ±0.2 mV)', () => {
    const b = stage(() => Part('LM393'), { vin: 2, vref: 2, pin: 'inp', rp: 10e3, vpu: 5 });
    const withSweep = bench('sweep', tb => {
      b.build(tb);
      tb.expect.dc({ source: 'VI', from: 1.99, to: 2.01, points: 201 }).probe('out').toCross(2.5).between(0, 10);
    });
    const r = runLadder(withSweep);
    const x = r.stages.dc!.assertions![0].measured!;
    expect(Math.abs(x - (2 - 2e-3))).toBeLessThan(2e-4);
  });

  it('LM393 response time: 1.3 µs at 5 mV overdrive, 0.3 µs with a large step (data typ; ±15 %)', () => {
    // Datasheet test: 100 mV step, RL 5.1 kΩ to 5 V, CL 15 pF, time to the output crossing 1.4 V.
    // The threshold of the input on inn is V(inp) + Vos, so the step ends 5 mV beyond it.
    const vos = 2e-3;
    const small = stage(() => Part('LM393'), {
      vin: { pulse: { v1: vos - 0.095, v2: vos + 0.005, td: 2e-6, tr: 1e-9, tf: 1e-9, pw: 20e-6 } },
      vref: 0,
      pin: 'inn',
      rp: 5.1e3,
      vpu: 5,
      cl: 15e-12,
    });
    const ws = tran(small, 'out', { tstop: 8e-6, dt: 10e-9 });
    expect(at(ws, 1.9e-6)).toBeGreaterThan(4.9);
    const tSmall = crossing(ws, 1.4, 2e-6) - 2e-6;
    expect(rel(tSmall, 1.3e-6)).toBeLessThan(0.15);
    const big = stage(() => Part('LM393'), {
      vin: { pulse: { v1: vos - 1, v2: vos + 1, td: 2e-6, tr: 1e-9, tf: 1e-9, pw: 20e-6 } },
      vref: 0,
      pin: 'inn',
      rp: 5.1e3,
      vpu: 5,
      cl: 15e-12,
    });
    const wb = tran(big, 'out', { tstop: 4e-6, dt: 10e-9 });
    const tBig = crossing(wb, 1.4, 2e-6) - 2e-6;
    expect(rel(tBig, 0.3e-6)).toBeLessThan(0.2);
    expect(tBig).toBeLessThan(tSmall);
  });

  it('LM311 (emitter pin grounded, ±15 V): tHL 165 ns / tLH 115 ns at 5 mV overdrive (data typ; ±15 %), VOL near ground', () => {
    // Datasheet test: RC 500 Ω to 5 V, CL 5 pF.
    const vos = 2e-3;
    const b = stage(() => Part('LM311'), {
      vin: { pulse: { v1: vos - 0.095, v2: vos + 0.005, td: 1e-6, tr: 1e-9, tf: 1e-9, pw: 2e-6 } },
      vref: 0,
      pin: 'inn',
      rp: 500,
      vpu: 5,
      cl: 5e-12,
      rails: [15, -15],
      emitToGnd: true,
    });
    const w = tran(b, 'out', { tstop: 5e-6, dt: 2e-9 });
    // The step back is from +5 mV beyond to −95 mV beyond: a large overdrive, which LM311 data does not speed up.
    const tHL = crossing(w, 1.4, 1e-6) - 1e-6;
    const tLH = crossing(w, 1.4, 3e-6) - 3e-6;
    expect(rel(tHL, 165e-9)).toBeLessThan(0.15);
    expect(rel(tLH, 115e-9)).toBeLessThan(0.15);
    const low = at(w, 2.9e-6);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(0.2); // 10 mA through the 500 Ω pull-up: well inside the 0.75 V-at-50 mA curve
  });

  it('Schmitt trigger with external hysteresis resistors: thresholds match the resistor formula (±5 mV)', () => {
    // Inverting Schmitt on 5 V: vin → inn; inp = divider R1 (to VREF = 2.5 V) and R2 (to out); pull-up RP.
    const R1 = 10e3;
    const R2 = 100e3;
    const RP = 2.2e3;
    const VREF = 2.5;
    const b = bench('schmitt', tb => {
      const u = tb.add('U1', Part('LM393'));
      const vi = tb.add('VI', new VoltageSource({ pwl: { points: [[0, 1.5], [2e-3, 3.5], [4e-3, 1.5]] } }));
      const vr = tb.add('VR', new VoltageSource(VREF));
      const vcc = tb.add('VCC', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(R1));
      const r2 = tb.add('R2', new Resistor(R2));
      const rp = tb.add('RP', new Resistor(RP));
      vi.pin('+').connect(u.pin('inn'));
      vi.pin('-').connect(tb.gnd);
      vr.pin('+').connect(r1.pin('1'));
      vr.pin('-').connect(tb.gnd);
      r1.pin('2').connect(u.pin('inp'));
      r2.pin('1').connect(u.pin('inp'));
      r2.pin('2').connect(u.pin('out'));
      vcc.pin('+').connect(rp.pin('1'));
      vcc.pin('-').connect(tb.gnd);
      rp.pin('2').connect(u.pin('out'));
      vcc.pin('+').connect(u.pin('v+'));
      u.pin('v-').connect(tb.gnd);
      tb.name('out', u.pin('out'));
      tb.name('in', u.pin('inn'));
      tb.name('ref', u.pin('inp'));
    });
    const w = tran(b, 'out', { tstop: 4e-3, dt: 2e-6 });
    const win = tran(b, 'in', { tstop: 4e-3, dt: 2e-6 });
    const tUp = crossing(w, 2.5, 0); // output falls when the rising input passes the upper threshold
    const tDown = crossing(w, 2.5, 2e-3); // output rises when the falling input passes the lower threshold
    const vth = at(win, tUp);
    const vtl = at(win, tDown);
    // Output high: pull-up RP against the R2 + R1 path to VREF; output low: the model's saturation (from the run).
    const voh = (5 * (R1 + R2) + VREF * RP) / (R1 + R2 + RP);
    const vol = Math.min(...w.y);
    const vos = 2e-3;
    const div = (vo: number) => VREF + ((vo - VREF) * R1) / (R1 + R2);
    // The input on inn switches the output when V(inn) = V(inp) + Vos.
    expect(Math.abs(vth - (div(voh) + vos))).toBeLessThan(5e-3);
    expect(Math.abs(vtl - (div(vol) + vos))).toBeLessThan(5e-3);
    expect(vth - vtl).toBeGreaterThan(0.2); // ≈ (VOH − VOL)·R1/(R1 + R2)
  });

  it('the generic Comparator uses its documented defaults and accepts unit strings', () => {
    const c = new Comparator({ tpdHL: '200n', tpdLH: '200n', isink: '20m' });
    expect(c.params.tpdHL).toBeCloseTo(200e-9, 15);
    expect(c.params.isink).toBe(0.02);
    expect(() => new Comparator({ iol: 0.05, isink: 0.01 })).toThrow(/iol/);
  });
});
