import { Component } from './Component';

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
}
