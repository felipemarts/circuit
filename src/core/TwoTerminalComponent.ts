import { Component } from './Component';
import type { Phasor } from '../analysis/context';

export abstract class TwoTerminalComponent extends Component {
  private _voltage = 0;
  private _current = 0;

  constructor() {
    super();
    this.addPin('1');
    this.addPin('2');
  }

  get voltage(): number {
    return this._voltage;
  }

  get current(): number {
    return this._current;
  }

  /** @internal Called by the solver after analysis */
  _setResults(voltage: number, current: number): void {
    this._voltage = voltage;
    this._current = current;
  }

  /** Node index of pin 1 (positive terminal) */
  get _n1Index(): number {
    return this.pin('1').node.index;
  }

  /** Node index of pin 2 (negative terminal) */
  get _n2Index(): number {
    return this.pin('2').node.index;
  }

  /** Small-signal voltage V(1) − V(2) from an AC solution. */
  protected acVoltage(re: ArrayLike<number>, im: ArrayLike<number>): Phasor {
    const a = this._n1Index;
    const b = this._n2Index;
    const vr = (a > 0 ? re[a - 1] : 0) - (b > 0 ? re[b - 1] : 0);
    const vi = (a > 0 ? im[a - 1] : 0) - (b > 0 ? im[b - 1] : 0);
    return [vr, vi];
  }
}
