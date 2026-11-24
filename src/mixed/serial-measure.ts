/**
 * tb.expect.serial evaluation over an MCU's recorded serial log (src/mcu/measure.ts).
 * Nothing is invented: a time is reported only when the text was printed.
 */
import type { CheckSpec } from '../schema/types';
import type { SerialEntry } from '../mcu/types';
import { serialFirstTime, serialLines, serialText } from '../mcu/measure';

export interface SerialOutcome {
  pass: boolean;
  measured?: number;
  outsideBy?: number;
  note?: string;
}

const EXCERPT = 160;

function excerpt(text: string): string {
  const flat = JSON.stringify(text.length > EXCERPT ? `…${text.slice(-EXCERPT)}` : text);
  return text.length === 0 ? 'nothing was printed' : `output: ${flat}`;
}

export function evaluateSerialCheck(check: CheckSpec, log: SerialEntry[]): SerialOutcome {
  const text = serialText(log);
  switch (check.op) {
    case 'serialContains': {
      const t = serialFirstTime(log, check.text);
      if (t === undefined) return { pass: false, note: `${JSON.stringify(check.text)} was never printed; ${excerpt(text)}` };
      if (check.by !== undefined && t > check.by) {
        return { pass: false, measured: t, outsideBy: Number((t - check.by).toPrecision(6)), note: `${JSON.stringify(check.text)} was printed at t=${t}s, after by=${check.by}s` };
      }
      return { pass: true, measured: t };
    }
    case 'serialNotContains': {
      const t = serialFirstTime(log, check.text);
      if (t === undefined) return { pass: true };
      return { pass: false, measured: t, note: `${JSON.stringify(check.text)} was printed at t=${t}s` };
    }
    case 'serialMatches': {
      const re = new RegExp(check.pattern, (check.flags ?? '').replace(/g/g, ''));
      const m = re.exec(text);
      if (!m) return { pass: false, note: `no match for /${check.pattern}/${check.flags ?? ''}; ${excerpt(text)}` };
      return { pass: true, measured: serialFirstTime(log, re), note: `matched ${JSON.stringify(m[0])}` };
    }
    case 'serialLines': {
      const n = serialLines(log).filter(l => l.complete).length;
      if (check.count !== undefined) {
        const pass = n === check.count;
        return { pass, measured: n, ...(pass ? {} : { outsideBy: Math.abs(n - check.count) }) };
      }
      const lo = check.min ?? 0;
      const hi = check.max ?? Infinity;
      const pass = n >= lo && n <= hi;
      return { pass, measured: n, ...(pass ? {} : { outsideBy: n < lo ? lo - n : n - hi }) };
    }
  }
  throw new Error(`not a serial check: ${check.op}`);
}
