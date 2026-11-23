/**
 * Behavioral models of the digital primitives. Each model only talks to the
 * kernel through `Host`; all configuration arrives as validated plain-JSON
 * params (see parts.ts).
 */
import { AND_T, BUF_T, CX, NOT_T, OR_T, S1, XOR_T, DZ, SX, strong, weak, toCode } from './logic';
import type { Code, Logic } from './logic';
import type { Host, Model, ModelCtx } from './model';
import {
  EDGE_FALL,
  EDGE_MAYBE_RISE,
  EDGE_RISE,
  TimingChecker,
  classifyEdge,
  timingDiagnostic,
  unknownControlDiagnostic,
} from './model';
import { toTicks } from './units';

// ── combinational ──

export type GateOp = 'and' | 'or' | 'xor' | 'buf';

export class GateModel implements Model {
  private ins: number[];
  private y: number;
  private table: readonly Code[] | null;

  constructor(ctx: ModelCtx, inputPins: string[], op: GateOp, private invert: boolean) {
    this.ins = inputPins.map(p => ctx.inputs[p]);
    this.y = ctx.outputs.y;
    this.table = op === 'and' ? AND_T : op === 'or' ? OR_T : op === 'xor' ? XOR_T : null;
  }

  reset(): void {}

  evaluate(h: Host): void {
    const ins = this.ins;
    let v: number = BUF_T[h.read(ins[0])];
    const t = this.table;
    if (t) for (let i = 1; i < ins.length; i++) v = t[v * 4 + h.read(ins[i])];
    if (this.invert) v = NOT_T[v];
    h.out(this.y, v | 8);
  }
}

export class TriBufModel implements Model {
  private a: number;
  private en: number;
  private y: number;
  constructor(ctx: ModelCtx, private activeLow: boolean) {
    this.a = ctx.inputs.a;
    this.en = ctx.inputs.en;
    this.y = ctx.outputs.y;
  }
  reset(): void {}
  evaluate(h: Host): void {
    let en: number = BUF_T[h.read(this.en)];
    if (this.activeLow) en = NOT_T[en];
    h.out(this.y, en === 1 ? BUF_T[h.read(this.a)] | 8 : en === 0 ? DZ : SX);
  }
}

export class MuxModel implements Model {
  private sel: number[];
  private data: number[];
  private y: number;
  constructor(ctx: ModelCtx, k: number) {
    this.sel = Array.from({ length: k }, (_, i) => ctx.inputs[`s${i}`]);
    this.data = Array.from({ length: 1 << k }, (_, i) => ctx.inputs[`d${i}`]);
    this.y = ctx.outputs.y;
  }
  reset(): void {}
  evaluate(h: Host): void {
    let index = 0;
    let unknownMask = 0;
    for (let i = 0; i < this.sel.length; i++) {
      const s = BUF_T[h.read(this.sel[i])];
      if (s === 1) index |= 1 << i;
      else if (s === CX) unknownMask |= 1 << i;
    }
    let v: number;
    if (unknownMask === 0) {
      v = BUF_T[h.read(this.data[index])];
    } else {
      // Unknown select: the output is known only if every candidate input agrees.
      v = -1;
      for (let i = 0; i < this.data.length; i++) {
        if ((i & ~unknownMask) !== index) continue;
        const d = BUF_T[h.read(this.data[i])];
        if (v === -1) v = d;
        else if (v !== d) {
          v = CX;
          break;
        }
      }
    }
    h.out(this.y, v | 8);
  }
}

// ── sources ──

export class ConstModel implements Model {
  constructor(
    private ctx: ModelCtx,
    private value: Logic,
    private pull: boolean,
  ) {}
  reset(h: Host): void {
    const c = toCode(this.value);
    h.out(this.ctx.outputs.y, this.pull ? weak(c) : strong(c));
  }
  evaluate(): void {}
}

export interface ClockParams {
  period: number;
  duty: number;
  start: number;
  stop?: number;
}

export class ClockModel implements Model {
  private y: number;
  private startTicks: number;
  private periodTicks: number;
  private highTicks: number;
  private stopTicks: number;
  constructor(private ctx: ModelCtx, p: ClockParams) {
    this.y = ctx.outputs.y;
    this.startTicks = p.start * 1e12;
    this.periodTicks = p.period * 1e12;
    this.highTicks = p.duty * this.periodTicks;
    this.stopTicks = p.stop === undefined ? Infinity : toTicks(p.stop);
  }
  /** Transition m: even = rising edge of cycle m/2, odd = falling edge. Computed from the index, never accumulated. */
  private timeOf(m: number): number {
    const cycle = Math.floor(m / 2);
    return Math.round(this.startTicks + cycle * this.periodTicks + (m % 2 === 1 ? this.highTicks : 0));
  }
  /** A first rising edge at exactly t = 0 is part of the power-on state: the clock starts high, no edge event. */
  private get edgeAtZero(): boolean {
    return this.timeOf(0) === 0;
  }
  reset(h: Host): void {
    h.out(this.y, this.edgeAtZero ? S1 : strong(0));
  }
  evaluate(): void {}
  start(h: Host): void {
    this.schedule(h, this.edgeAtZero ? 1 : 0);
  }
  wake(h: Host, m: number): void {
    this.schedule(h, m + 1);
  }
  private schedule(h: Host, m: number): void {
    const t = this.timeOf(m);
    if (t > this.stopTicks) return;
    h.outAt(this.y, m % 2 === 0 ? S1 : strong(0), t);
    h.wakeAt(this.ctx.comp, t, m);
  }
}

export class StimulusModel implements Model {
  constructor(
    private ctx: ModelCtx,
    private initial: Logic,
    private changes: [number, Logic][],
  ) {}
  /** Changes at exactly t = 0 are folded into the power-on value (no t = 0 edge). */
  reset(h: Host): void {
    let v = this.initial;
    for (const [t, c] of this.changes) if (toTicks(t) === 0) v = c;
    h.out(this.ctx.outputs.y, strong(toCode(v)));
  }
  evaluate(): void {}
  start(h: Host): void {
    for (const [t, v] of this.changes) {
      const tick = toTicks(t);
      if (tick > 0) h.outAt(this.ctx.outputs.y, strong(toCode(v)), tick);
    }
  }
}

// ── sequential ──

export interface SeqParams {
  setup: number;
  hold: number;
  onViolation: 'x' | 'keep';
}

/** Async set/reset state: -1 inactive, 0/1 forced value, CX unknown. */
function asyncForce(s: number, r: number): number {
  const sa = BUF_T[s];
  const ra = BUF_T[r];
  if (sa === 0 && ra === 0) return -1;
  if (sa === 1 && ra === 1) return CX; // both asserted: undefined
  if (ra === 1) return 0;
  if (sa === 1) return 1;
  return -2; // at least one unknown, none definitely asserted
}

abstract class FlipFlopBase implements Model {
  protected q: number;
  protected prevClk: number = CX;
  protected prev: number[];
  private cur: number[];
  private dataNets: number[];
  protected timing: TimingChecker;
  protected oq: number;
  protected oqn: number;
  private setPin: number;
  private resetPin: number;
  private clkPin: number;

  constructor(
    protected ctx: ModelCtx,
    protected dataPins: string[],
    protected p: SeqParams & { init: Logic },
  ) {
    this.q = toCode(p.init);
    this.prev = dataPins.map(() => CX);
    this.cur = dataPins.map(() => CX);
    this.dataNets = dataPins.map(pn => ctx.inputs[pn]);
    this.timing = new TimingChecker(toTicks(p.setup), toTicks(p.hold), dataPins);
    this.oq = ctx.outputs.q;
    this.oqn = ctx.outputs.qn;
    this.setPin = ctx.inputs.set ?? -1;
    this.resetPin = ctx.inputs.reset ?? -1;
    this.clkPin = ctx.inputs.clk;
  }

  /** Next state at an active edge from the sampled data values. */
  protected abstract next(data: number[]): number;

  reset(h: Host): void {
    this.emit(h);
  }

  protected emit(h: Host): void {
    h.out(this.oq, this.q | 8);
    h.out(this.oqn, NOT_T[this.q] | 8);
  }

  evaluate(h: Host): void {
    const id = this.ctx.id;
    // Double-buffered input samples: no allocation on the hot path.
    const data = this.cur;
    for (let i = 0; i < data.length; i++) data[i] = h.read(this.dataNets[i]);
    const clk = h.read(this.clkPin);
    const force = asyncForce(this.setPin >= 0 ? h.read(this.setPin) : 0, this.resetPin >= 0 ? h.read(this.resetPin) : 0);
    if (h.initializing) {
      this.prevClk = clk;
      this.cur = this.prev;
      this.prev = data;
      if (force >= 0) this.q = force;
      this.emit(h);
      return;
    }
    let q = this.q;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== this.prev[i]) {
        const v = this.timing.dataChanged(i, h.tick);
        if (v) {
          h.report(timingDiagnostic(id, v, 'rising clk edge', this.p.onViolation === 'x'));
          if (this.p.onViolation === 'x') q = CX;
        }
      }
    }
    this.cur = this.prev;
    this.prev = data;
    const edge = classifyEdge(this.prevClk as Code, clk);
    this.prevClk = clk;
    if (force >= 0) {
      q = force;
      if (edge === EDGE_RISE) this.timing.edge(h.tick);
    } else if (force === -2) {
      if (q !== 0 && q !== 1) q = CX;
      else {
        // Either control might be acting; unknown unless it would not change anything.
        const sUnknown = this.setPin >= 0 && BUF_T[h.read(this.setPin)] === CX;
        const rUnknown = this.resetPin >= 0 && BUF_T[h.read(this.resetPin)] === CX;
        if ((sUnknown && q !== 1) || (rUnknown && q !== 0)) {
          h.report(unknownControlDiagnostic(id, sUnknown ? 'set' : 'reset', h.tick, 'asynchronous control unknown'));
          q = CX;
        }
      }
    } else if (edge === EDGE_RISE) {
      const v = this.timing.edge(h.tick);
      if (v) {
        h.report(timingDiagnostic(id, v, 'rising clk edge', this.p.onViolation === 'x'));
        q = this.p.onViolation === 'x' ? CX : this.nextFrom(data, q);
      } else {
        q = this.nextFrom(data, q);
      }
    } else if (edge === EDGE_MAYBE_RISE) {
      const cand = this.nextFrom(data, q);
      if (cand !== q) {
        h.report(unknownControlDiagnostic(id, 'clk', h.tick, 'possible rising edge through X'));
        q = CX;
      }
    }
    this.q = q;
    this.emit(h);
  }

  private nextFrom(data: number[], q: number): number {
    this.q = q;
    return this.next(data);
  }
}

export class DffModel extends FlipFlopBase {
  constructor(ctx: ModelCtx, p: SeqParams & { init: Logic }) {
    super(ctx, ['d'], p);
  }
  protected next(data: number[]): number {
    return BUF_T[data[0]];
  }
}

function jk(j: number, k: number, q: number): number {
  if (j === 0 && k === 0) return q;
  if (j === 1 && k === 0) return 1;
  if (j === 0 && k === 1) return 0;
  return NOT_T[q];
}

export class JkModel extends FlipFlopBase {
  constructor(ctx: ModelCtx, p: SeqParams & { init: Logic }) {
    super(ctx, ['j', 'k'], p);
  }
  protected next(data: number[]): number {
    const js = BUF_T[data[0]] === CX ? [0, 1] : [data[0]];
    const ks = BUF_T[data[1]] === CX ? [0, 1] : [data[1]];
    const qs = this.q === CX ? [0, 1] : [this.q];
    let r = -1;
    for (const j of js) for (const k of ks) for (const q of qs) {
      const n = jk(j, k, q);
      if (r === -1) r = n;
      else if (r !== n) return CX;
    }
    return r;
  }
}

export class LatchModel implements Model {
  private q: number;
  private prevEn: number = CX;
  private prevD: number = CX;
  private timing: TimingChecker;
  constructor(private ctx: ModelCtx, private p: SeqParams & { init: Logic }) {
    this.q = toCode(p.init);
    this.timing = new TimingChecker(toTicks(p.setup), toTicks(p.hold), ['d']);
  }
  private emit(h: Host): void {
    h.out(this.ctx.outputs.q, this.q | 8);
    h.out(this.ctx.outputs.qn, NOT_T[this.q] | 8);
  }
  reset(h: Host): void {
    this.emit(h);
  }
  evaluate(h: Host): void {
    const d = h.read(this.ctx.inputs.d);
    const en = BUF_T[h.read(this.ctx.inputs.en)];
    if (h.initializing) {
      this.prevEn = en;
      this.prevD = d;
      if (en === 1) this.q = BUF_T[d];
      this.emit(h);
      return;
    }
    const id = this.ctx.id;
    let q = this.q;
    if (d !== this.prevD) {
      // Hold is checked only while the latch is closed (after the closing edge).
      const v = this.timing.dataChanged(0, h.tick, en === 0);
      if (v) {
        h.report(timingDiagnostic(id, v, 'falling en edge', this.p.onViolation === 'x'));
        if (this.p.onViolation === 'x') q = CX;
      }
    }
    this.prevD = d;
    const edge = classifyEdge(this.prevEn as Code, en as Code);
    this.prevEn = en;
    if (en === 1) {
      q = BUF_T[d];
    } else if (edge === EDGE_FALL) {
      const v = this.timing.edge(h.tick);
      if (v) {
        h.report(timingDiagnostic(id, v, 'falling en edge', this.p.onViolation === 'x'));
        if (this.p.onViolation === 'x') q = CX;
      }
    } else if (en === CX && BUF_T[d] !== q) {
      h.report(unknownControlDiagnostic(id, 'en', h.tick, 'latch enable unknown'));
      q = CX;
    }
    this.q = q;
    this.emit(h);
  }
}

export interface CounterParams extends SeqParams {
  bits: number;
  enable: boolean;
  reset: boolean;
  resetMode: 'async' | 'sync';
  upDown: boolean;
  init: number;
}

export class CounterModel implements Model {
  /** Count, or -1 when unknown. */
  private state: number;
  private prevClk: number = CX;
  private prev: number[];
  private dataPins: string[];
  private timing: TimingChecker;
  private outs: number[];
  private modulo: number;

  constructor(private ctx: ModelCtx, private p: CounterParams) {
    this.state = p.init;
    this.modulo = 2 ** p.bits;
    this.dataPins = [...(p.enable ? ['en'] : []), ...(p.upDown ? ['up'] : []), ...(p.reset && p.resetMode === 'sync' ? ['reset'] : [])];
    this.prev = this.dataPins.map(() => CX);
    this.timing = new TimingChecker(toTicks(p.setup), toTicks(p.hold), this.dataPins);
    this.outs = Array.from({ length: p.bits }, (_, i) => ctx.outputs[`q${i}`]);
  }
  private emit(h: Host): void {
    for (let i = 0; i < this.outs.length; i++) {
      h.out(this.outs[i], this.state < 0 ? SX : (Math.floor(this.state / 2 ** i) % 2) | 8);
    }
  }
  reset(h: Host): void {
    this.emit(h);
  }
  evaluate(h: Host): void {
    const ins = this.ctx.inputs;
    const id = this.ctx.id;
    const clk = h.read(ins.clk);
    const data = this.dataPins.map(pn => h.read(ins[pn]));
    const r = this.p.reset ? BUF_T[h.read(ins.reset)] : 0;
    const asyncReset = this.p.reset && this.p.resetMode === 'async';
    if (h.initializing) {
      this.prevClk = clk;
      this.prev = data;
      if (asyncReset && r === 1) this.state = 0;
      this.emit(h);
      return;
    }
    let s = this.state;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== this.prev[i]) {
        const v = this.timing.dataChanged(i, h.tick);
        if (v) {
          h.report(timingDiagnostic(id, v, 'rising clk edge', this.p.onViolation === 'x'));
          if (this.p.onViolation === 'x') s = -1;
        }
      }
    }
    this.prev = data;
    const edge = classifyEdge(this.prevClk as Code, clk);
    this.prevClk = clk;
    if (asyncReset && r === 1) {
      s = 0;
      if (edge === EDGE_RISE) this.timing.edge(h.tick);
    } else if (asyncReset && r === CX) {
      if (s !== 0) {
        h.report(unknownControlDiagnostic(id, 'reset', h.tick, 'asynchronous reset unknown'));
        s = -1;
      }
    } else if (edge === EDGE_RISE) {
      const v = this.timing.edge(h.tick);
      if (v) {
        h.report(timingDiagnostic(id, v, 'rising clk edge', this.p.onViolation === 'x'));
        if (this.p.onViolation === 'x') s = -1;
        else s = this.count(h, s, r);
      } else {
        s = this.count(h, s, r);
      }
    } else if (edge === EDGE_MAYBE_RISE) {
      const en = this.p.enable ? BUF_T[h.read(ins.en)] : 1;
      if (en !== 0 || (!asyncReset && r !== 0)) {
        h.report(unknownControlDiagnostic(id, 'clk', h.tick, 'possible rising edge through X'));
        s = -1;
      }
    }
    this.state = s;
    this.emit(h);
  }
  private count(h: Host, s: number, r: number): number {
    const ins = this.ctx.inputs;
    if (this.p.reset && this.p.resetMode === 'sync') {
      if (r === 1) return 0;
      if (r === CX) return -1;
    }
    const en = this.p.enable ? BUF_T[h.read(ins.en)] : 1;
    if (en === 0) return s;
    if (en === CX || s < 0) return -1;
    const up = this.p.upDown ? BUF_T[h.read(ins.up)] : 1;
    if (up === CX) return -1;
    return (s + (up === 1 ? 1 : this.modulo - 1)) % this.modulo;
  }
}

export interface ShiftParams extends SeqParams {
  bits: number;
  mode: 'sipo' | 'piso';
  serialIn: boolean;
  reset: boolean;
  init: number;
}

export class ShiftModel implements Model {
  private bits: number[];
  private prevClk: number = CX;
  private prev: number[];
  private dataPins: string[];
  private timing: TimingChecker;
  private qOuts: number[];
  private so: number;

  constructor(private ctx: ModelCtx, private p: ShiftParams) {
    this.bits = Array.from({ length: p.bits }, (_, i) => Math.floor(p.init / 2 ** i) % 2);
    const n = p.bits;
    this.dataPins =
      p.mode === 'sipo'
        ? ['si']
        : ['load', ...Array.from({ length: n }, (_, i) => `p${i}`), ...(p.serialIn ? ['si'] : [])];
    this.prev = this.dataPins.map(() => CX);
    this.timing = new TimingChecker(toTicks(p.setup), toTicks(p.hold), this.dataPins);
    this.qOuts = p.mode === 'sipo' ? Array.from({ length: n }, (_, i) => ctx.outputs[`q${i}`]) : [];
    this.so = ctx.outputs.so;
  }
  private emit(h: Host): void {
    for (let i = 0; i < this.qOuts.length; i++) h.out(this.qOuts[i], this.bits[i] | 8);
    h.out(this.so, this.bits[this.bits.length - 1] | 8);
  }
  reset(h: Host): void {
    this.emit(h);
  }
  evaluate(h: Host): void {
    const ins = this.ctx.inputs;
    const id = this.ctx.id;
    const clk = h.read(ins.clk);
    const data = this.dataPins.map(pn => h.read(ins[pn]));
    const r = this.p.reset ? BUF_T[h.read(ins.reset)] : 0;
    if (h.initializing) {
      this.prevClk = clk;
      this.prev = data;
      if (r === 1) this.bits.fill(0);
      this.emit(h);
      return;
    }
    let poisoned = false;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== this.prev[i]) {
        const v = this.timing.dataChanged(i, h.tick);
        if (v) {
          h.report(timingDiagnostic(id, v, 'rising clk edge', this.p.onViolation === 'x'));
          if (this.p.onViolation === 'x') poisoned = true;
        }
      }
    }
    this.prev = data;
    const edge = classifyEdge(this.prevClk as Code, clk);
    this.prevClk = clk;
    if (r === 1) {
      this.bits.fill(0);
      if (edge === EDGE_RISE) this.timing.edge(h.tick);
    } else if (r === CX) {
      if (this.bits.some(b => b !== 0)) {
        h.report(unknownControlDiagnostic(id, 'reset', h.tick, 'asynchronous reset unknown'));
        this.bits.fill(CX);
      }
    } else if (edge === EDGE_RISE) {
      const v = this.timing.edge(h.tick);
      if (v) {
        h.report(timingDiagnostic(id, v, 'rising clk edge', this.p.onViolation === 'x'));
        if (this.p.onViolation === 'x') poisoned = true;
        else this.shift(h);
      } else {
        this.shift(h);
      }
    } else if (edge === EDGE_MAYBE_RISE) {
      h.report(unknownControlDiagnostic(id, 'clk', h.tick, 'possible rising edge through X'));
      this.bits.fill(CX);
    }
    if (poisoned) this.bits.fill(CX);
    this.emit(h);
  }
  private shift(h: Host): void {
    const ins = this.ctx.inputs;
    const b = this.bits;
    if (this.p.mode === 'piso') {
      const load = BUF_T[h.read(ins.load)];
      if (load === 1) {
        for (let i = 0; i < b.length; i++) b[i] = BUF_T[h.read(ins[`p${i}`])];
        return;
      }
      if (load === CX) {
        b.fill(CX);
        return;
      }
    }
    for (let i = b.length - 1; i > 0; i--) b[i] = b[i - 1];
    b[0] = this.p.mode === 'piso' && !this.p.serialIn ? 0 : BUF_T[h.read(ins.si)];
  }
}
