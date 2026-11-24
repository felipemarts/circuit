import { Circuit, VoltageSource, CurrentSource, SimulationSystem } from '../../src/forge';
import type { Component, Phasor } from '../../src/forge';

export type Q = Component & { quantity(n: string): number };

/** Solve the DC operating point of a hand-wired circuit. */
export function op(c: Circuit): void {
  c.analyze('dc');
}

/** Drive a diode with a DC current (anode ← source) and return its voltage. */
export function diodeVoltageAt(d: Q, i: number): number {
  const c = new Circuit();
  const s = new CurrentSource(i);
  s.pin('+').connect(d.pin('anode'));
  s.pin('-').connect(c.ground);
  d.pin('cathode').connect(c.ground);
  op(c);
  return d.quantity('v');
}

/** Small-signal admittance of a two-terminal device biased at V (Y = I/V at frequency f). */
export function admittance(dev: Component & { acReadResults: Component['acReadResults'] }, v: number, f: number): Phasor {
  const c = new Circuit();
  const src = new VoltageSource({ dc: v, ac: 1 });
  src.pin('+').connect(dev.pin('1'));
  src.pin('-').connect(c.ground);
  dev.pin('2').connect(c.ground);
  const sys = new SimulationSystem(c);
  try {
    sys.operatingPoint();
    const { re, im, matrix } = sys.acSolve(f);
    const r = dev.acReadResults(re, im, 2 * Math.PI * f, matrix)!;
    return r.current!;
  } finally {
    sys.release();
  }
}

/** Bisect Ib (current source into the base, emitter grounded, Vce fixed) for a target Ic; returns hFE. */
export function hfeAt(make: () => Q, ic: number, vce: number, sign = 1): { hfe: number; ib: number } {
  let lo = 1e-10;
  let hi = 1e-1;
  let ib = 0;
  let icm = 0;
  for (let k = 0; k < 90; k++) {
    ib = Math.sqrt(lo * hi);
    const c = new Circuit();
    const q = make();
    const vc = new VoltageSource(sign * vce);
    const is = new CurrentSource(sign * ib);
    vc.pin('+').connect(q.pin('c'));
    vc.pin('-').connect(c.ground);
    is.pin('+').connect(q.pin('b'));
    is.pin('-').connect(c.ground);
    q.pin('e').connect(c.ground);
    op(c);
    icm = sign * q.quantity('ic');
    if (icm > ic) hi = ib;
    else lo = ib;
  }
  return { hfe: icm / ib, ib };
}

/** Rds(on) of a MOSFET at (Vgs, Id): drain fed by a current source. */
export function rdsOn(m: Q, vgs: number, id: number): number {
  const c = new Circuit();
  const vg = new VoltageSource(vgs);
  const is = new CurrentSource(id);
  is.pin('+').connect(m.pin('d'));
  is.pin('-').connect(c.ground);
  vg.pin('+').connect(m.pin('g'));
  vg.pin('-').connect(c.ground);
  m.pin('s').connect(c.ground);
  op(c);
  return m.quantity('vds') / id;
}
