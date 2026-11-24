import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import { parseValue } from '../core/units';
import { ReactiveState } from '../analysis/integration';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';

/**
 * Ideal inductor. It always owns a branch-current unknown: at DC the branch
 * equation is V(1) − V(2) = 0 (a short), in transient V = L·di/dt is
 * integrated by the engine, in AC V = jωL·I.
 */
export class Inductor extends TwoTerminalComponent {
  readonly kind: string = 'Inductor';
  readonly inductance: number;
  /** @internal branch-current index */
  _vsIndex: number = -1;
  /** @internal flux state integrated by the transient engine */
  readonly _phi: ReactiveState;

  constructor(inductance: number | string) {
    super();
    const l = parseValue(inductance, 'inductance');
    if (l <= 0) {
      throw new Error(`Inductance must be a finite number > 0, got ${inductance}`);
    }
    this.inductance = l;
    // abstol on the derivative (a voltage): vntol 1e-6 V; flux floor 1e-14 Wb.
    this._phi = new ReactiveState(this, 1e-6, 1e-14);
    // The branch current is unknown index (nodes − 1) + branch; the engine
    // stores that offset in _branchRow when it indexes the system.
    this._phi.evaluate = x => this.inductance * x[this._branchRow];
  }

  /** @internal matrix row of the branch current (set on load) */
  _branchRow = -1;

  /** DC: short circuit (0 V branch). */
  stamp(matrix: MNAMatrix): void {
    matrix.stampVoltageSource(this._n1Index, this._n2Index, this._vsIndex, 0);
  }

  load(ctx: LoadContext): void {
    if (ctx.mode !== 'tran') {
      this.stamp(ctx.matrix);
      return;
    }
    const m = ctx.matrix.vsIndex(this._vsIndex);
    const p = ctx.matrix.nodeRow(this._n1Index);
    const n = ctx.matrix.nodeRow(this._n2Index);
    // KCL incidence: the branch current leaves pin 1 and enters pin 2.
    ctx.matrix.add(p, m, 1);
    ctx.matrix.add(n, m, -1);
    if (ctx.initial) {
      // Hold the initial current.
      ctx.matrix.add(m, m, 1);
      ctx.matrix.addRHS(m, this._phi.hx[0] / this.inductance);
      return;
    }
    this._branchRow = m;
    const i = ctx.x[m];
    const { derivative, coeff } = ctx.integrate(this._phi, this.inductance * i);
    // V(1) − V(2) = vL = coeff·L·i + hist
    const req = coeff * this.inductance;
    ctx.matrix.add(m, p, 1);
    ctx.matrix.add(m, n, -1);
    ctx.matrix.add(m, m, -req);
    ctx.matrix.addRHS(m, derivative - req * i);
  }

  initTransient(ctx: InitContext): void {
    const i = ctx.x[ctx.matrix.vsIndex(this._vsIndex)];
    const v = ctx.v(this._n1Index) - ctx.v(this._n2Index);
    ctx.setState(this._phi, this.inductance * i, ctx.fromOp ? 0 : v);
  }

  acceptStep(_ctx: AcceptContext): void {}

  /** Reset the transient state to the zero state (0 A). */
  resetToDC(): void {
    this._phi.seed(0, 0);
  }

  // --- Protocol methods ---

  getVSourceCount(): number {
    return 1;
  }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const mat = ctx.matrix;
    const m = mat.vsIndex(this._vsIndex);
    mat.stampBranchIncidence(this._n1Index, this._n2Index, this._vsIndex);
    mat.add(m, m, 0, -ctx.omega * this.inductance);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, _omega: number, matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    const m = matrix.vsIndex(this._vsIndex);
    return { voltage: this.acVoltage(re, im), current: [re[m], im[m]] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    return { voltage: v1 - v2, current: matrix.getVSourceCurrent(solution, this._vsIndex) };
  }
}
