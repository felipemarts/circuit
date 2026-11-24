import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, LoadContext, Phasor } from '../analysis/context';
import {
  parseSource,
  sourceMaxStep,
  sourceNextBreakpoint,
  sourceParams,
  sourceValueAt,
  type AcStimulus,
  type SourceOptions,
} from './source';
import type { WaveformSpec } from './waveforms';

/**
 * Ideal independent current source: it pushes its current out of the '+' pin
 * into the circuit and takes it back through '-'. Same options as
 * VoltageSource:
 *
 *   new CurrentSource('1m')
 *   new CurrentSource({ pulse: { v1: 0, v2: '1m', pw: '10u', per: '20u' } })
 */
export class CurrentSource extends TwoTerminalComponent {
  readonly kind: string = 'CurrentSource';
  /** DC value: operating point and DC sweep. */
  readonly currentValue: number;
  readonly waveform: WaveformSpec | null;
  readonly acStimulus: AcStimulus | null;
  /** @internal DC-sweep override of the DC value */
  _sweepValue: number | null = null;
  private _present: number;

  constructor(current: number | string | SourceOptions) {
    super();
    this.pins.set('+', this.pin('1'));
    this.pins.set('-', this.pin('2'));
    const parsed = parseSource(current, 'CurrentSource', 'current');
    this.currentValue = parsed.dc;
    this.waveform = parsed.wave;
    this.acStimulus = parsed.ac;
    this._present = parsed.dc;
  }

  currentAtTime(t: number): number {
    return sourceValueAt(this.waveform, this.currentValue, t);
  }

  /** Plain-JSON configuration (netlist params). */
  describeParams(): Record<string, unknown> {
    return sourceParams('i', this.currentValue, this.waveform, this.acStimulus);
  }

  stamp(matrix: MNAMatrix): void {
    // Current flows from pin '-' to pin '+' (into pin 1)
    matrix.stampCurrentSource(this._n1Index, this._n2Index, this._present);
  }

  load(ctx: LoadContext): void {
    const value = ctx.mode === 'dc' ? (this._sweepValue ?? this.currentValue) : this.currentAtTime(ctx.time);
    this._present = value;
    ctx.matrix.stampCurrentSource(this._n1Index, this._n2Index, value * ctx.srcFactor);
  }

  nextBreakpoint(t: number): number {
    return sourceNextBreakpoint(this.waveform, t);
  }

  maxStepHint(): number {
    return sourceMaxStep(this.waveform);
  }

  setTime(t: number): void {
    this._present = this.currentAtTime(t);
  }

  resetToDC(): void {
    this._present = this.currentValue;
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const ac = this.acStimulus;
    if (ac && ac.mag !== 0) {
      const ph = (ac.phase * Math.PI) / 180;
      ctx.matrix.stampCurrentSource(this._n1Index, this._n2Index, ac.mag * Math.cos(ph), ac.mag * Math.sin(ph));
    }
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>): { voltage: Phasor; current: Phasor } {
    const ac = this.acStimulus;
    const ph = ac ? (ac.phase * Math.PI) / 180 : 0;
    return { voltage: this.acVoltage(re, im), current: ac ? [ac.mag * Math.cos(ph), ac.mag * Math.sin(ph)] : [0, 0] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    return { voltage: v1 - v2, current: this._present };
  }
}
