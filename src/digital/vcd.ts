/**
 * Value Change Dump (IEEE 1364 VCD) export of a recording — opens in GTKWave
 * and any logic-analyzer view. Deterministic: no date/version lines, nets in
 * name order, identifiers assigned by that order.
 */
import type { Logic } from './logic';
import type { DigitalRecording } from './sim';
import { toTicks } from './units';

function vcdId(i: number): string {
  // Printable ASCII '!'..'~' (94 symbols), little-endian base 94.
  let s = '';
  do {
    s += String.fromCharCode(33 + (i % 94));
    i = Math.floor(i / 94);
  } while (i > 0);
  return s;
}

const ch = (v: Logic): string => (v === 'X' ? 'x' : v === 'Z' ? 'z' : String(v));

export function toVCD(rec: DigitalRecording, opts: { scope?: string } = {}): string {
  const names = Object.keys(rec.traces).sort();
  const ids = new Map(names.map((n, i) => [n, vcdId(i)]));
  const lines: string[] = ['$timescale 1ps $end', `$scope module ${opts.scope ?? 'top'} $end`];
  for (const n of names) lines.push(`$var wire 1 ${ids.get(n)} ${n.replace(/\s/g, '_')} $end`);
  lines.push('$upscope $end', '$enddefinitions $end');
  const byTick = new Map<number, string[]>();
  for (const n of names) {
    const tr = rec.traces[n];
    for (let i = 0; i < tr.t.length; i++) {
      const tick = toTicks(tr.t[i]);
      const list = byTick.get(tick) ?? [];
      list.push(`${ch(tr.v[i])}${ids.get(n)}`);
      byTick.set(tick, list);
    }
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  for (const tick of ticks) {
    lines.push(`#${tick}`);
    if (tick === 0) lines.push('$dumpvars', ...byTick.get(tick)!, '$end');
    else lines.push(...byTick.get(tick)!);
  }
  const end = toTicks(rec.tEnd);
  if (ticks.length === 0 || end > ticks[ticks.length - 1]) lines.push(`#${end}`);
  return lines.join('\n') + '\n';
}
