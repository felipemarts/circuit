import { defineComponent } from 'circuitsvibe';

/**
 * LM7805 — fixed 5 V linear regulator (78xx family), pins IN, GND, OUT
 * (TO-220: 1 = IN, 2 = GND, 3 = OUT).
 *
 * Behavioural model with typical datasheet figures of the LM340 / µA7805
 * family at 25 °C: the output follows min(vout, Vin − dropout) behind
 * `rout` (load regulation), the pass device only sources current (it cannot
 * pull OUT down), the output current is limited to `ilim`, and `iq` flows
 * from IN to GND whenever the input is up; a 10 kΩ feedback divider loads
 * OUT. Every corner is smoothed so the
 * Newton iterations converge. Not modelled: line regulation, ripple
 * rejection versus frequency, thermal shutdown, the dropout's dependence on
 * the load current. Dissipation is (Vin − Vout)·Iout + Vin·Iq — check it
 * against the package (TO-220 without a heatsink: about 1–2 W).
 *
 * Params: vout 5 V · dropout 2 V · rout 10 mΩ · ilim 2.2 A · iq 5 mA.
 */
const EPS_V = 0.05; // corner of min(vout, Vin − dropout), V
const EPS_I = 1e-3; // corner of the "sources only" clamp, A (shifts the output by EPS_I/2 · rout: µV)
const R_DIV = 10e3; // internal feedback divider OUT → GND, Ω
const EPS_LIM = 0.02; // corner of the current limit, A
const STEP_V = 1; // largest change of vi / vo between two Newton iterations, V
/**
 * Floor of the pass device's slope in the Jacobian, as a fraction of 1/rout,
 * while the step limiter is active. In current limit and when the device is
 * off the true slope is ~0, and far from the solution Newton would bounce
 * between the two plateaus; the floor only shapes those iterations — near the
 * solution the true slope is used, and the converged current is the true one.
 */
const K_FLOOR = 0.02;

/** Smooth min(a, b) and its partial derivatives. */
function smin(a: number, b: number, eps: number): [number, number, number] {
  const r = Math.sqrt((a - b) * (a - b) + eps * eps);
  return [(a + b - r) / 2, (1 - (a - b) / r) / 2, (1 + (a - b) / r) / 2];
}

/** Smooth max(x, 0) and its derivative. */
function spos(x: number, eps: number): [number, number] {
  const r = Math.sqrt(x * x + eps * eps);
  return [(x + r) / 2, (1 + x / r) / 2];
}

/**
 * Pass-device current IN → OUT and its derivatives with respect to
 * vi = V(IN) − V(GND) and vo = V(OUT) − V(GND).
 */
function pass(p: Record<string, number>, vi: number, vo: number, floor = 0): { i: number; di: number; dout: number } {
  const [vt, , dvtVi] = smin(p.vout, vi - p.dropout, EPS_V);
  const x = (vt - vo) / p.rout;
  const [i0, di0] = spos(x, EPS_I);
  const [i, , dLim] = smin(p.ilim, i0, EPS_LIM);
  const k = Math.max(dLim * di0, floor);
  return { i, di: (k * dvtVi) / p.rout, dout: -k / p.rout };
}

/** Quiescent current IN → GND (rises with the input, ≈ iq above a couple of volts) and its derivative. */
function quiescent(p: Record<string, number>, vi: number): [number, number] {
  const v = Math.max(vi, 0);
  return [(p.iq * v * v) / (v * v + 1), (p.iq * 2 * v) / ((v * v + 1) * (v * v + 1))];
}

export default defineComponent({
  name: 'LM7805',
  pins: ['in', 'gnd', 'out'],
  params: {
    vout: { default: 5, unit: 'V' },
    dropout: { default: 2, unit: 'V' },
    rout: { default: 0.01, unit: 'Ω' },
    ilim: { default: 2.2, unit: 'A' },
    iq: { default: 0.005, unit: 'A' },
  },
  nonlinear: true,
  stamp(ctx) {
    // The loop gain is 1/rout (100 S): limit how far vi and vo move per Newton
    // iteration (like SPICE's junction limiting), or the first iterations overshoot.
    let vi = ctx.voltage('in') - ctx.voltage('gnd');
    let vo = ctx.voltage('out') - ctx.voltage('gnd');
    const clamp = (v: number, prev: number | undefined): number => (prev === undefined ? v : Math.min(prev + STEP_V, Math.max(prev - STEP_V, v)));
    const [li, lo] = [clamp(vi, ctx.state.vi), clamp(vo, ctx.state.vo)];
    const limiting = li !== vi || lo !== vo;
    if (limiting) ctx.limited();
    [vi, vo] = [li, lo];
    ctx.state.vi = vi;
    ctx.state.vo = vo;
    const p = ctx.params;
    const m = ctx.matrix;
    const [nIn, nGnd, nOut] = [ctx.nodeIndex('in'), ctx.nodeIndex('gnd'), ctx.nodeIndex('out')];

    // Pass device: I ≈ I0 + di·(vi − vi0) + dout·(vo − vo0), leaving IN and entering OUT.
    const s = pass(p, vi, vo, limiting ? K_FLOOR : 0);
    m.stampTransconductance(nIn, nOut, nIn, nGnd, s.di);
    m.stampTransconductance(nIn, nOut, nOut, nGnd, s.dout);
    ctx.stampCurrentSource('out', 'in', s.i - s.di * vi - s.dout * vo);

    // Quiescent current IN → GND.
    const [iq, gq] = quiescent(p, vi);
    ctx.stampConductance('in', 'gnd', gq);
    ctx.stampCurrentSource('gnd', 'in', iq - gq * vi);

    // The internal feedback divider: also keeps an unpowered output from floating.
    ctx.stampConductance('out', 'gnd', 1 / R_DIV);
  },
  ac(ctx) {
    const vi = ctx.voltage('in') - ctx.voltage('gnd');
    const vo = ctx.voltage('out') - ctx.voltage('gnd');
    const s = pass(ctx.params, vi, vo);
    ctx.stampTransconductance('in', 'out', 'in', 'gnd', s.di);
    ctx.stampTransconductance('in', 'out', 'out', 'gnd', s.dout);
    ctx.stampConductance('in', 'gnd', quiescent(ctx.params, vi)[1]);
    ctx.stampConductance('out', 'gnd', 1 / R_DIV);
  },
});
