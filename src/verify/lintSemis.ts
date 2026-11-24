/**
 * Semiconductor lint rules (pre-solver, graph only). Each rule is precise:
 * it fires only when the topology alone proves the problem.
 *
 *   F107 (warning) BJT base with no DC drive — only capacitors / other bases on its net
 *   F109 (error)   BJT junction forward-clamped by ideal sources (no base resistor)
 *   F110 (warning) P-type device wired with its emitter/source at the circuit's lowest
 *                  potential (or N-type at the highest): it can never conduct
 *   T005–T008      `.model` card problems recorded by fromModel()
 * F108 (MOSFET gate with no DC path) lives in lint.ts next to F101, which it replaces.
 */
import type { Elaboration } from '../elab/bench';
import type { Diagnostic, NetlistComponent, ParamValue } from '../schema/types';

const MODEL_SLUG: Record<string, string> = {
  T005: 'model-unknown-param',
  T006: 'model-unsupported',
  T007: 'model-parse-error',
  T008: 'model-param-not-modeled',
};

/** T005–T008 from components built with fromModel(). */
export function modelDiagnostics(elab: Elaboration): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const id of [...elab.components.keys()].sort()) {
    const comp = elab.components.get(id) as unknown as { modelDiagnostics?: { code: string; severity: 'error' | 'warning'; message: string; params?: string[] }[] };
    for (const d of comp.modelDiagnostics ?? []) {
      const fix =
        d.code === 'T005'
          ? 'check the parameter names for typos; parameters this simulator does not know are ignored (circuitsvibe catalog <type> lists the supported ones)'
          : d.code === 'T006'
            ? 'use a supported model (D, NPN, PNP, NMOS/PMOS LEVEL=1) or a catalog Part(); nothing was simulated'
            : d.code === 'T007'
              ? 'fix the .model card syntax: .model <name> <type>(<param>=<value> ...), values with SPICE suffixes (4p, 1.5meg, 10u)'
              : 'the listed parameters change the device in a full SPICE run but are ignored here; expect differences in the effects they model';
      out.push({
        code: d.code,
        slug: MODEL_SLUG[d.code] ?? 'model',
        severity: d.severity,
        stage: 'lint',
        message: `${id}: ${d.message}`,
        subject: { components: [id] },
        ...(d.params ? { evidence: { params: [...d.params] } } : {}),
        fixes: [{ kind: 'fix-model', confidence: 'suggested', detail: fix }],
        at: elab.locOf.get(id),
      });
    }
  }
  return out;
}

const KNOWN_DC_TYPES = new Set(['Resistor', 'VoltageSource', 'Diode', 'LED', 'NPN', 'PNP', 'NMOS', 'PMOS', 'Switch', 'Button']);

/** [min, max] of a voltage source over time, from its netlist params. */
function sourceRange(params: Record<string, ParamValue>): [number, number] | null {
  const vals: number[] = [];
  if (typeof params.v === 'number') vals.push(params.v);
  const num = (o: unknown, k: string) => (o && typeof (o as Record<string, unknown>)[k] === 'number' ? ((o as Record<string, number>)[k]) : undefined);
  if (params.pulse) vals.push(num(params.pulse, 'v1') ?? 0, num(params.pulse, 'v2') ?? 0);
  if (params.pwm) vals.push(num(params.pwm, 'low') ?? 0, num(params.pwm, 'high') ?? 0);
  if (params.sin) {
    const off = num(params.sin, 'offset') ?? 0;
    const a = Math.abs(num(params.sin, 'amplitude') ?? 0);
    vals.push(off - a, off + a);
  }
  if (params.pwl) {
    const pts = (params.pwl as { points?: [number, number][] }).points;
    if (!Array.isArray(pts)) return null;
    for (const p of pts) vals.push(p[1]);
  }
  if (vals.some(v => !Number.isFinite(v))) return null;
  return [Math.min(...vals), Math.max(...vals)];
}

export function lintSemiconductors(elab: Elaboration, reached: Set<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const doc = elab.netlist;
  const comps = doc.components.filter(c => reached.has(c.id));
  const byId = new Map(doc.components.map(c => [c.id, c]));
  const isBjt = (c: NetlistComponent) => c.type === 'NPN' || c.type === 'PNP';
  const isMos = (c: NetlistComponent) => c.type === 'NMOS' || c.type === 'PMOS';
  const paramsOf = (id: string) => (elab.components.get(id) as unknown as { params?: Record<string, number> }).params ?? {};

  // Fixed potentials set by ideal sources (weighted union-find, as F105).
  const parent = new Map<string, string>();
  const offset = new Map<string, number>();
  const find = (x: string): [string, number] => {
    if (!parent.has(x)) {
      parent.set(x, x);
      offset.set(x, 0);
    }
    const p = parent.get(x)!;
    if (p === x) return [x, 0];
    const [root, pp] = find(p);
    const total = offset.get(x)! + pp;
    parent.set(x, root);
    offset.set(x, total);
    return [root, total];
  };
  for (const src of comps) {
    let plus: string | undefined;
    let minus: string | undefined;
    let v: number | undefined;
    if (src.type === 'VoltageSource') {
      plus = src.pins['+'];
      minus = src.pins['-'];
      v = typeof src.params['v'] === 'number' ? (src.params['v'] as number) : undefined;
    } else if (src.type === 'Inductor') {
      plus = src.pins['1'];
      minus = src.pins['2'];
      v = 0;
    }
    if (!plus || !minus || v === undefined || plus === minus) continue;
    const [rp, pp] = find(plus);
    const [rm, pm] = find(minus);
    if (rp === rm) continue;
    parent.set(rp, rm);
    offset.set(rp, v + pm - pp);
  }

  // ── F109: BJT junction clamped by ideal sources ──
  const CLAMP_CURRENT_LIMIT = 100;
  for (const c of comps.filter(isBjt)) {
    const t = c.type === 'NPN' ? 1 : -1;
    const p = paramsOf(c.id);
    const Is = p.Is ?? 1e-16;
    const Vt = p.Vt ?? 0.02585;
    for (const [other, n, label] of [['e', p.Nf ?? 1, 'base-emitter'], ['c', p.Nr ?? 1, 'base-collector']] as const) {
      const nb = c.pins['b'];
      const nx = c.pins[other];
      if (!nb || !nx || nb === nx) continue;
      const [rb, pb] = find(nb);
      const [rx, px] = find(nx);
      if (rb !== rx) continue;
      const drop = t * (pb - px);
      const series = (p.Rb ?? 0) + (other === 'e' ? p.Re ?? 0 : p.Rc ?? 0);
      const expCurrent = drop > 0 ? Is * Math.exp(Math.min(drop / (n * Vt), 700)) : 0;
      const est = series > 0 ? Math.min(expCurrent, drop / series) : expCurrent;
      if (est <= CLAMP_CURRENT_LIMIT) continue;
      out.push({
        code: 'F109',
        slug: 'bjt-junction-clamped',
        severity: 'error',
        stage: 'lint',
        message: `${c.id} ${label} junction is forward-clamped at ${Number(drop.toFixed(3))} V by ideal source(s) with no series resistance — its own model puts the junction current at ~${est.toExponential(1)} A`,
        subject: { components: [c.id], pins: [`${c.id}.b`, `${c.id}.${other}`] },
        note: 'a transistor junction is a diode: driving the base straight from a voltage source fixes Vbe, and the exponential current is limited by nothing (a real part burns; Newton-Raphson diverges)',
        evidence: { clampVoltage: drop, estimatedCurrent: est },
        fixes: [
          {
            kind: 'add-component',
            confidence: 'suggested',
            detail: `insert a base resistor between the driving source and ${c.id}.b — e.g. Rb = (Vdrive − 0.7 V)/Ib with Ib ≈ Ic/10 for a saturated switch`,
          },
        ],
        at: elab.locOf.get(c.id),
      });
    }
  }

  // ── F107: BJT base with no DC drive ──
  for (const c of comps.filter(isBjt)) {
    const net = c.pins['b'];
    if (!net || net === 'gnd') continue;
    const others = (doc.nets[net] ?? []).filter(ref => ref !== `${c.id}.b`);
    const undriven = others.every(ref => {
      const [cid, pin] = ref.split('.');
      const o = byId.get(cid);
      if (!o) return false;
      return o.type === 'Capacitor' || (isBjt(o) && pin === 'b');
    });
    if (!undriven) continue;
    const viaCap = others.some(ref => byId.get(ref.split('.')[0])?.type === 'Capacitor');
    out.push({
      code: 'F107',
      slug: 'bjt-base-floating',
      severity: 'warning',
      stage: 'lint',
      message: `${c.id} base (net ${net}) has no DC bias${viaCap ? ' — it is reached only through a capacitor' : others.length === 0 ? ' — the pin is unconnected' : ''}: the transistor sits in cutoff at DC`,
      subject: { net, components: [c.id], pins: [`${c.id}.b`, ...others] },
      note: 'with no resistor, source or current source on the base net, no base current can flow at DC, so Ic ≈ 0 (cutoff); an AC-coupled input then only drives the junction above ~0.6 V peaks',
      fixes: [
        {
          kind: 'add-component',
          confidence: 'suggested',
          detail: `bias the base of ${c.id}: a resistor divider from the supply to ${net}, or a base resistor from the driving signal`,
        },
      ],
      at: elab.locOf.get(c.id),
    });
  }

  // ── F110: P-type at the lowest potential / N-type at the highest ──
  // Precise only for purely resistive circuits (Wolaver's no-gain theorem: every
  // node voltage lies within the range of the ground-referenced source voltages).
  {
    const devices = comps.filter(c => isBjt(c) || isMos(c));
    const resistiveOnly = comps.every(c => KNOWN_DC_TYPES.has(c.type));
    const sources = comps.filter(c => c.type === 'VoltageSource');
    const ranges = sources.map(s => (s.pins['-'] === 'gnd' ? sourceRange(s.params) : null));
    if (devices.length > 0 && resistiveOnly && sources.length > 0 && ranges.every(r => r !== null)) {
      const lo = Math.min(0, ...ranges.map(r => r![0]));
      const hi = Math.max(0, ...ranges.map(r => r![1]));
      // Nets pinned at a constant extreme potential.
      const pinnedAt = (net: string | undefined, level: number): boolean => {
        if (!net) return false;
        if (net === 'gnd') return level === 0;
        return sources.some((s, i) => s.pins['+'] === net && ranges[i]![0] === level && ranges[i]![1] === level);
      };
      for (const c of devices) {
        const ref = isBjt(c) ? 'e' : 's';
        const pType = c.type === 'PNP' || c.type === 'PMOS';
        if (isMos(c)) {
          const vto = paramsOf(c.id).Vto ?? 0;
          if (pType ? !(vto < 0) : !(vto > 0)) continue; // depletion devices can conduct at Vgs = 0
          if (c.pins['b'] && c.pins['b'] !== c.pins['s']) continue;
        }
        const extreme = pType ? lo : hi;
        if (hi === lo || !pinnedAt(c.pins[ref], extreme)) continue;
        const where = pType ? 'lowest' : 'highest';
        const name = isBjt(c) ? 'emitter' : 'source';
        out.push({
          code: 'F110',
          slug: 'reversed-polarity',
          severity: 'warning',
          stage: 'lint',
          message: `${c.id} (${c.type}) has its ${name} on ${c.pins[ref]}, the ${where} potential in the circuit (${extreme} V): it can never be turned on — wired like ${pType ? 'an N' : 'a P'}-type device?`,
          subject: { net: c.pins[ref], components: [c.id] },
          note: `${pType ? 'a P-type device conducts when its control terminal is BELOW its ' + name : 'an N-type device conducts when its control terminal is ABOVE its ' + name}; in a circuit of resistors, diodes, transistors and ground-referenced sources no node can go ${pType ? 'below' : 'above'} ${extreme} V, so it stays off`,
          fixes: [
            {
              kind: 'rewire',
              confidence: 'suggested',
              detail: pType
                ? `connect ${c.id}.${ref} to the positive supply (high-side switch) or use an ${c.type === 'PNP' ? 'NPN' : 'NMOS'} here`
                : `connect ${c.id}.${ref} to ground (low-side switch) or use a ${c.type === 'NPN' ? 'PNP' : 'PMOS'} here`,
            },
          ],
          at: elab.locOf.get(c.id),
        });
      }
    }
  }
  return out;
}
