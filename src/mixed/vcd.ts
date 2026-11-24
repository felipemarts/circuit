/** VCD export of a RunRecord logic capture (circuitsvibe verify --vcd out.vcd). */
import type { LogicCapture } from '../schema/types';
import { toVCD } from '../digital/vcd';
import type { NetTrace } from '../digital/sim';

/** One VCD for a capture; signal names are sanitized for VCD identifiers. */
export function toLogicVCD(cap: LogicCapture): string {
  const traces: Record<string, NetTrace> = {};
  for (const [name, list] of Object.entries(cap.signals)) {
    const safe = name.replace(/[^A-Za-z0-9_.[\]~']/g, '_');
    traces[safe] = { net: safe, t: list.map(e => e[0]), v: list.map(e => e[1]) };
  }
  return toVCD({ schema: 'circuitsvibe-digital-wave/0.1', tEnd: cap.tEnd, traces });
}
