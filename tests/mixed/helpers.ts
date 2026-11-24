import { elaborate, VoltageSource, type BenchDescriptor, type Elaboration } from '../../src/forge';
import type { TB } from '../../src/forge';
import type { LogicIC } from '../../src/mixed/device';
import type { Pin } from '../../src/core/Pin';

/** Supply + ground an IC: VCC from a fresh source V<id> (or the given pin), GND to tb.gnd. */
export function power(tb: TB, u: LogicIC, vcc: number | Pin, id = 'VCC1'): Pin {
  let plus: Pin;
  if (typeof vcc === 'number') {
    const v = tb.add(id, new VoltageSource(vcc));
    v.pin('-').connect(tb.gnd);
    plus = v.pin('+');
  } else plus = vcc;
  u.pin(u.supplyName('vcc')).connect(plus);
  u.pin(u.supplyName('gnd')).connect(tb.gnd);
  return plus;
}

/** Tie the listed input pins to ground. */
export function tieLow(tb: TB, u: LogicIC, pins: (string | number)[]): void {
  for (const p of pins) u.pin(p).connect(tb.gnd);
}

/** Transient waveforms of node/pin probes (adaptive), via the elaboration's circuit. */
export function waves(desc: BenchDescriptor, tstop: number, probes: string[], maxStep = tstop / 200): { elab: Elaboration; t: number[]; v: Record<string, number[]> } {
  const elab = elaborate(desc);
  elab.mixed?.controller.setTimeScale(tstop);
  const specs = probes.map(p => {
    const node = elab.netNode.get(p) ?? elab.mixed?.pinNode(p);
    if (node) return { label: p, color: '', node, type: 'voltage' as const };
    const [id, q] = p.split('.');
    return { label: p, color: '', component: elab.components.get(id)!, type: q === 'i' ? ('current' as const) : ('voltage' as const) };
  });
  const r = elab.circuit.analyze('transient', { timeStep: maxStep / 10, maxStep, duration: tstop, adaptive: true }, specs);
  elab.mixed?.controller.finishTransient(tstop);
  return { elab, t: r.timePoints, v: Object.fromEntries(r.probes.map(p => [p.label, p.values])) };
}

/** First time (linear interpolation) a waveform crosses `level` in the given direction after `from`. */
export function crossing(t: number[], y: number[], level: number, dir: 'rise' | 'fall', from = 0): number | undefined {
  for (let i = 1; i < t.length; i++) {
    if (t[i] < from) continue;
    const a = y[i - 1] - level;
    const b = y[i] - level;
    if (dir === 'rise' ? a < 0 && b >= 0 : a > 0 && b <= 0) return t[i - 1] + ((t[i] - t[i - 1]) * -a) / (b - a);
  }
  return undefined;
}
