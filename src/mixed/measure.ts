/**
 * Logic assertion evaluation over recorded digital traces (tb.expect.logic).
 * Measurements come from src/digital/measure; nothing is invented when a
 * measurement cannot be made (fewer than two rising edges → note, no value).
 */
import type { NetTrace } from '../digital/sim';
import { dutyCycle, edgeCount, edgeTimes, frequency, valueAt } from '../digital/measure';
import { fromTicks, toTicks } from '../digital/units';
import type { CheckSpec, LogicLevel } from '../schema/types';

export interface LogicOutcome {
  pass: boolean;
  measured?: number;
  measuredLogic?: LogicLevel;
  outsideBy?: number;
  ratio?: number;
  tFirstViolation?: number;
  note?: string;
}

const num = (v: LogicLevel): number | undefined => (v === 0 || v === 1 ? v : undefined);

export function evaluateLogicCheck(check: CheckSpec, tr: NetTrace, tstop: number): LogicOutcome {
  switch (check.op) {
    case 'logicAt': {
      const v = valueAt(tr, check.t) as LogicLevel;
      const m = num(v);
      return { pass: v === check.value, ...(m !== undefined ? { measured: m } : {}), measuredLogic: v };
    }
    case 'logicEdges': {
      const w = { from: check.from ?? 0, to: check.to ?? tstop };
      const n = edgeCount(tr, check.edge, w);
      let pass: boolean;
      let outsideBy: number | undefined;
      if (check.count !== undefined) {
        pass = n === check.count;
        outsideBy = Math.abs(n - check.count);
      } else {
        const lo = check.min ?? 0;
        const hi = check.max ?? Infinity;
        pass = n >= lo && n <= hi;
        outsideBy = n < lo ? lo - n : n > hi ? n - hi : 0;
      }
      return { pass, measured: n, ...(pass ? {} : { outsideBy }) };
    }
    case 'logicFrequency': {
      const w = { from: check.from ?? 0, to: check.to ?? tstop };
      const f = frequency(tr, w);
      if (f === undefined) {
        return { pass: false, note: `fewer than two rising edges of ${tr.net} in [${w.from}, ${w.to}] s — no period to measure` };
      }
      const err = Math.abs(f - check.value);
      const pass = err <= check.tol * check.value;
      return { pass, measured: Number(f.toPrecision(9)), ...(pass ? {} : { outsideBy: Number((err - check.tol * check.value).toPrecision(6)), ratio: Number((f / check.value).toPrecision(4)) }) };
    }
    case 'logicDutyCycle': {
      const w = { from: check.from ?? 0, to: check.to ?? tstop };
      const d = dutyCycle(tr, w);
      if (d === undefined) {
        return { pass: false, note: `fewer than two rising edges of ${tr.net} in [${w.from}, ${w.to}] s — no whole period to measure` };
      }
      const err = Math.abs(d - check.value);
      const pass = err <= check.tol;
      return { pass, measured: Number(d.toPrecision(9)), ...(pass ? {} : { outsideBy: Number((err - check.tol).toPrecision(6)) }) };
    }
    case 'logicStable': {
      const v0 = valueAt(tr, check.from) as LogicLevel;
      const expected = check.value ?? v0;
      if (v0 !== expected) {
        const m = num(v0);
        return { pass: false, ...(m !== undefined ? { measured: m } : {}), measuredLogic: v0, tFirstViolation: check.from };
      }
      const from = toTicks(check.from);
      const to = toTicks(check.to);
      for (let i = 0; i < tr.t.length; i++) {
        const k = toTicks(tr.t[i]);
        if (k <= from || k > to) continue;
        if (tr.v[i] !== expected) {
          const v = tr.v[i] as LogicLevel;
          const m = num(v);
          return { pass: false, ...(m !== undefined ? { measured: m } : {}), measuredLogic: v, tFirstViolation: fromTicks(k) };
        }
      }
      const m = num(expected);
      return { pass: true, ...(m !== undefined ? { measured: m } : {}), measuredLogic: expected };
    }
    default:
      throw new Error(`not a logic check: ${check.op}`);
  }
}

/** Up to 11 value changes around a time, as [t, value] (for failed logic assertions). */
export function logicExcerpt(tr: NetTrace, t: number): [number, LogicLevel][] {
  let i = tr.t.findIndex(x => x >= t);
  if (i < 0) i = tr.t.length - 1;
  const out: [number, LogicLevel][] = [];
  for (let k = Math.max(0, i - 5); k <= Math.min(tr.t.length - 1, i + 5); k++) out.push([tr.t[k], tr.v[k] as LogicLevel]);
  return out;
}

export { edgeTimes };
