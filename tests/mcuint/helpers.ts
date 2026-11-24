import { elaborate, VoltageSource, type BenchDescriptor, type Elaboration, type TB, type FirmwareBundle, type Mcu } from '../../src/forge';
import { TransientAnalysis } from '../../src/analysis/TransientAnalysis';

/** A one-file firmware bundle (path `fw/<name>`), for benches built in tests. */
export function fw(source: string, name = 'app.fw.ts'): FirmwareBundle {
  return { entry: `fw/${name}`, files: { [`fw/${name}`]: source } };
}

/** Power an MCU from a fresh ideal source `V<id>` (VCC / the board's 5V pin, GND to tb.gnd). */
export function powerMcu(tb: TB, u: Mcu, volts = 5, id = 'VS'): VoltageSource {
  const v = tb.add(id, new VoltageSource(volts));
  v.pin('-').connect(tb.gnd);
  u.pin(u.vccName).connect(v.pin('+'));
  u.pin('GND').connect(tb.gnd);
  return v;
}

/** Async transient waveforms of node/pin/component probes (MCU benches). */
export async function wavesAsync(
  desc: BenchDescriptor,
  tstop: number,
  probes: string[],
  maxStep = tstop / 200,
): Promise<{ elab: Elaboration; t: number[]; v: Record<string, number[]> }> {
  const elab = elaborate(desc);
  elab.mixed?.controller.setTimeScale(tstop);
  const specs = probes.map(p => {
    const node = elab.netNode.get(p) ?? elab.mixed?.pinNode(p);
    if (node) return { label: p, color: '', node, type: 'voltage' as const };
    const [id, q] = p.split('.');
    return { label: p, color: '', component: elab.components.get(id)!, type: q === 'i' ? ('current' as const) : ('voltage' as const) };
  });
  const r = await new TransientAnalysis().runAsync(elab.circuit, { timeStep: maxStep / 10, maxStep, duration: tstop, adaptive: true }, specs);
  elab.mixed?.controller.finishTransient(tstop);
  return { elab, t: r.timePoints, v: Object.fromEntries(r.probes.map(p => [p.label, p.values])) };
}

/** Value of a sampled waveform at time t (linear interpolation). */
export function at(t: number[], y: number[], time: number): number {
  let i = t.findIndex(x => x >= time);
  if (i < 0) return y[y.length - 1];
  if (i === 0) return y[0];
  const f = (time - t[i - 1]) / (t[i] - t[i - 1]);
  return y[i - 1] + f * (y[i] - y[i - 1]);
}
