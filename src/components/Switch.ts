import { Component } from '../core/Component';
import type { MNAMatrix } from '../solver/MNAMatrix';

const R_CLOSED = 1e-3; // 1 mΩ — effectively a short
const R_OPEN = 1e12;   // 1 TΩ — effectively an open circuit

/**
 * SPDT (single-pole double-throw) switch with 3 terminals:
 *   com ─┬─ a   (active when `closed === false`)
 *        └─ b   (active when `closed === true`)
 *
 * Modelled as two parallel conductances from `com` to `a` and `com` to `b`.
 * One channel has R_CLOSED (effectively shorted), the other R_OPEN.
 */
export class Switch extends Component {
  readonly kind: string = 'Switch';
  closed: boolean;
  private _voltage = 0;
  private _current = 0;

  constructor(closed = false) {
    super();
    this.addPin('com');
    this.addPin('a');
    this.addPin('b');
    this.closed = closed;
  }

  get voltage(): number { return this._voltage; }
  get current(): number { return this._current; }

  /** @internal */
  _setResults(voltage: number, current: number): void {
    this._voltage = voltage;
    this._current = current;
  }

  toggle(): void {
    this.closed = !this.closed;
  }

  stamp(matrix: MNAMatrix): void {
    const com = this.pin('com').node.index;
    const a = this.pin('a').node.index;
    const b = this.pin('b').node.index;
    const g_a = 1 / (this.closed ? R_OPEN : R_CLOSED);
    const g_b = 1 / (this.closed ? R_CLOSED : R_OPEN);
    matrix.stampConductance(com, a, g_a);
    matrix.stampConductance(com, b, g_b);
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const vCom = matrix.getNodeVoltage(solution, this.pin('com').node.index);
    const targetPin = this.closed ? 'b' : 'a';
    const vTarget = matrix.getNodeVoltage(solution, this.pin(targetPin).node.index);
    const voltage = vCom - vTarget;
    return { voltage, current: voltage / R_CLOSED };
  }
}
