import { Component } from '../core/Component';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, Phasor } from '../analysis/context';

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

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const com = this.pin('com').node.index;
    const a = this.pin('a').node.index;
    const b = this.pin('b').node.index;
    ctx.matrix.stampAdmittance(com, a, 1 / (this.closed ? R_OPEN : R_CLOSED), 0);
    ctx.matrix.stampAdmittance(com, b, 1 / (this.closed ? R_CLOSED : R_OPEN), 0);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>): { voltage: Phasor; current: Phasor } {
    const com = this.pin('com').node.index;
    const target = this.pin(this.closed ? 'b' : 'a').node.index;
    const vr = (com > 0 ? re[com - 1] : 0) - (target > 0 ? re[target - 1] : 0);
    const vi = (com > 0 ? im[com - 1] : 0) - (target > 0 ? im[target - 1] : 0);
    return { voltage: [vr, vi], current: [vr / R_CLOSED, vi / R_CLOSED] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const vCom = matrix.getNodeVoltage(solution, this.pin('com').node.index);
    const targetPin = this.closed ? 'b' : 'a';
    const vTarget = matrix.getNodeVoltage(solution, this.pin(targetPin).node.index);
    const voltage = vCom - vTarget;
    return { voltage, current: voltage / R_CLOSED };
  }
}
