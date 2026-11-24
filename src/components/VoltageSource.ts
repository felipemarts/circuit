import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
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
 * Ideal independent voltage source between '+' and '-'.
 *
 *   new VoltageSource(5)                                   // DC
 *   new VoltageSource({ dc: 2.5, ac: 1 })                  // DC bias + AC stimulus
 *   new VoltageSource({ pulse: { v1: 0, v2: 5, tr: '1u', tf: '1u', pw: '1m', per: '2m' } })
 *   new VoltageSource({ sin: { offset: 0, amplitude: 1, freq: '1k' } })
 *   new VoltageSource({ pwl: { points: [[0, 0], ['1m', 5]] } })
 *   new VoltageSource({ pwm: { low: 0, high: 5, freq: '10k', duty: 0.25 } })
 *
 * The DC value (operating point, DC sweep) is `dc`, defaulting to the
 * waveform's value at t = 0.
 */
export class VoltageSource extends TwoTerminalComponent {
  readonly kind: string = 'VoltageSource';
  /** DC value: operating point and DC sweep. */
  readonly declaredVoltage: number;
  /** Transient waveform (null: DC, or the legacy sine below). */
  readonly waveform: WaveformSpec | null;
  /** AC small-signal stimulus (null: 0). */
  readonly acStimulus: AcStimulus | null;
  /** @internal Assigned during analysis */
  _vsIndex: number = -1;

  /**
   * Legacy transient sine (visual editor): when `frequency > 0` and no
   * waveform is given, v(t) = declaredVoltage + acAmplitude·sin(2π·frequency·t).
   * Not the AC small-signal stimulus — that is the `ac` option.
   */
  acAmplitude: number = 0;
  frequency: number = 0;

  /** @internal DC-sweep override of the DC value */
  _sweepValue: number | null = null;

  /** @internal Effective voltage used by the legacy stamp() */
  _effectiveVoltage: number;

  constructor(voltage: number | string | SourceOptions) {
    super();
    const parsed = parseSource(voltage, 'VoltageSource', 'voltage');
    this.pins.set('+', this.pin('1'));
    this.pins.set('-', this.pin('2'));
    this.declaredVoltage = parsed.dc;
    this.waveform = parsed.wave;
    this.acStimulus = parsed.ac;
    this._effectiveVoltage = parsed.dc;
  }

  /** The waveform the transient analysis uses (including the legacy sine). */
  effectiveWaveform(): WaveformSpec | null {
    if (this.waveform) return this.waveform;
    if (this.frequency > 0) {
      return {
        sin: { offset: this.declaredVoltage, amplitude: this.acAmplitude, freq: this.frequency, delay: 0, damping: 0, phase: 0 },
      };
    }
    return null;
  }

  voltageAtTime(t: number): number {
    return sourceValueAt(this.effectiveWaveform(), this.declaredVoltage, t);
  }

  /** Plain-JSON configuration (netlist params). */
  describeParams(): Record<string, unknown> {
    return sourceParams('v', this.declaredVoltage, this.effectiveWaveform(), this.acStimulus);
  }

  stamp(matrix: MNAMatrix): void {
    matrix.stampVoltageSource(this._n1Index, this._n2Index, this._vsIndex, this._effectiveVoltage);
  }

  load(ctx: LoadContext): void {
    const value = ctx.mode === 'dc' ? (this._sweepValue ?? this.declaredVoltage) : this.voltageAtTime(ctx.time);
    this._effectiveVoltage = value;
    ctx.matrix.stampVoltageSource(this._n1Index, this._n2Index, this._vsIndex, value * ctx.srcFactor);
  }

  nextBreakpoint(t: number): number {
    return sourceNextBreakpoint(this.effectiveWaveform(), t);
  }

  maxStepHint(): number {
    return sourceMaxStep(this.effectiveWaveform());
  }

  // --- Protocol methods ---

  getVSourceCount(): number { return 1; }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  setTime(t: number): void {
    this._effectiveVoltage = this.voltageAtTime(t);
  }

  resetToDC(): void {
    this._effectiveVoltage = this.declaredVoltage;
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const mat = ctx.matrix;
    mat.stampBranchIncidence(this._n1Index, this._n2Index, this._vsIndex);
    const ac = this.acStimulus;
    if (ac && ac.mag !== 0) {
      const ph = (ac.phase * Math.PI) / 180;
      mat.addRHS(mat.vsIndex(this._vsIndex), ac.mag * Math.cos(ph), ac.mag * Math.sin(ph));
    }
  }

  acReadResults(
    re: ArrayLike<number>,
    im: ArrayLike<number>,
    _omega: number,
    matrix: ComplexMNAMatrix,
  ): { voltage: Phasor; current: Phasor } {
    const m = matrix.vsIndex(this._vsIndex);
    return { voltage: this.acVoltage(re, im), current: [re[m], im[m]] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    return {
      voltage: v1 - v2,
      current: matrix.getVSourceCurrent(solution, this._vsIndex),
    };
  }
}
