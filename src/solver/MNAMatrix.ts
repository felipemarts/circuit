import { luSolveInPlace } from './LUSolver';

/**
 * Modified Nodal Analysis matrix builder.
 *
 * Matrix layout: rows/cols 0..(nodeCount-2) are for node voltages (node indices 1..N map to matrix index 0..N-1).
 * Rows/cols (nodeCount-1)..(nodeCount-1+vsCount-1) are for branch currents (voltage sources, inductors).
 *
 * Node index 0 = ground, skipped in matrix entries.
 */
export class MNAMatrix {
  readonly size: number;
  readonly nodeCount: number;
  readonly G: Float64Array[];
  readonly z: Float64Array;

  constructor(nodeCount: number, vsourceCount: number) {
    // nodeCount includes ground (node 0), so matrix size = (nodeCount-1) + vsourceCount
    this.nodeCount = nodeCount;
    this.size = (nodeCount - 1) + vsourceCount;
    this.G = Array.from({ length: this.size }, () => new Float64Array(this.size));
    this.z = new Float64Array(this.size);
  }

  /** Map node index (1-based) to matrix row/col (0-based). Returns -1 for ground. */
  private idx(nodeIndex: number): number {
    if (nodeIndex === 0) return -1;
    return nodeIndex - 1;
  }

  /** Matrix row/col of a node (-1 for ground). */
  nodeRow(nodeIndex: number): number {
    return nodeIndex <= 0 ? -1 : nodeIndex - 1;
  }

  /** Matrix index for a voltage source extra variable */
  vsIndex(vsNumber: number): number {
    return (this.nodeCount - 1) + vsNumber;
  }

  clear(): void {
    for (let i = 0; i < this.size; i++) {
      this.z[i] = 0;
      this.G[i].fill(0);
    }
  }

  /** Raw matrix entry (0-based unknown indices; negative indices are ignored = ground). */
  add(row: number, col: number, value: number): void {
    if (row >= 0 && col >= 0) this.G[row][col] += value;
  }

  /** Raw right-hand-side entry (negative index ignored = ground). */
  addRHS(row: number, value: number): void {
    if (row >= 0) this.z[row] += value;
  }

  stampConductance(n1: number, n2: number, g: number): void {
    const i1 = this.idx(n1);
    const i2 = this.idx(n2);
    if (i1 >= 0) {
      this.G[i1][i1] += g;
      if (i2 >= 0) this.G[i1][i2] -= g;
    }
    if (i2 >= 0) {
      this.G[i2][i2] += g;
      if (i1 >= 0) this.G[i2][i1] -= g;
    }
  }

  /**
   * Voltage-controlled current source: current gm·(V(cp) − V(cn)) flows from
   * node `np` through the element into node `nn` (i.e. it leaves np).
   */
  stampTransconductance(np: number, nn: number, cp: number, cn: number, gm: number): void {
    const p = this.idx(np);
    const n = this.idx(nn);
    const a = this.idx(cp);
    const b = this.idx(cn);
    if (p >= 0) {
      if (a >= 0) this.G[p][a] += gm;
      if (b >= 0) this.G[p][b] -= gm;
    }
    if (n >= 0) {
      if (a >= 0) this.G[n][a] -= gm;
      if (b >= 0) this.G[n][b] += gm;
    }
  }

  stampVoltageSource(nPlus: number, nMinus: number, vsIdx: number, voltage: number): void {
    const ip = this.idx(nPlus);
    const im = this.idx(nMinus);
    const m = this.vsIndex(vsIdx);

    if (ip >= 0) {
      this.G[ip][m] += 1;
      this.G[m][ip] += 1;
    }
    if (im >= 0) {
      this.G[im][m] -= 1;
      this.G[m][im] -= 1;
    }
    this.z[m] = voltage;
  }

  stampCurrentSource(nPlus: number, nMinus: number, current: number): void {
    const ip = this.idx(nPlus);
    const im = this.idx(nMinus);
    // Current flows into nPlus
    if (ip >= 0) this.z[ip] += current;
    if (im >= 0) this.z[im] -= current;
  }

  solve(): number[] {
    const M = this.G.map(row => Float64Array.from(row));
    const rhs = Float64Array.from(this.z);
    luSolveInPlace(M, rhs);
    return Array.from(rhs);
  }

  /** Get node voltage from solution vector. Returns 0 for ground. */
  getNodeVoltage(solution: ArrayLike<number>, nodeIndex: number): number {
    if (nodeIndex <= 0) return 0;
    return solution[nodeIndex - 1];
  }

  /** Get voltage source current from solution vector. */
  getVSourceCurrent(solution: ArrayLike<number>, vsNumber: number): number {
    return solution[this.vsIndex(vsNumber)];
  }
}

/**
 * Complex MNA matrix for AC small-signal analysis. Same layout as MNAMatrix.
 */
export class ComplexMNAMatrix {
  readonly size: number;
  readonly nodeCount: number;
  readonly re: Float64Array[];
  readonly im: Float64Array[];
  readonly zRe: Float64Array;
  readonly zIm: Float64Array;

  constructor(nodeCount: number, vsourceCount: number) {
    this.nodeCount = nodeCount;
    this.size = nodeCount - 1 + vsourceCount;
    this.re = Array.from({ length: this.size }, () => new Float64Array(this.size));
    this.im = Array.from({ length: this.size }, () => new Float64Array(this.size));
    this.zRe = new Float64Array(this.size);
    this.zIm = new Float64Array(this.size);
  }

  nodeRow(nodeIndex: number): number {
    return nodeIndex <= 0 ? -1 : nodeIndex - 1;
  }

  vsIndex(vsNumber: number): number {
    return this.nodeCount - 1 + vsNumber;
  }

  clear(): void {
    for (let i = 0; i < this.size; i++) {
      this.re[i].fill(0);
      this.im[i].fill(0);
    }
    this.zRe.fill(0);
    this.zIm.fill(0);
  }

  add(row: number, col: number, re: number, im: number): void {
    if (row >= 0 && col >= 0) {
      this.re[row][col] += re;
      this.im[row][col] += im;
    }
  }

  addRHS(row: number, re: number, im: number): void {
    if (row >= 0) {
      this.zRe[row] += re;
      this.zIm[row] += im;
    }
  }

  /** Admittance y = re + j·im between two nodes. */
  stampAdmittance(n1: number, n2: number, re: number, im: number): void {
    const a = this.nodeRow(n1);
    const b = this.nodeRow(n2);
    this.add(a, a, re, im);
    this.add(b, b, re, im);
    this.add(a, b, -re, -im);
    this.add(b, a, -re, -im);
  }

  /** VCCS: gm·(V(cp)−V(cn)) leaves node np and enters node nn. */
  stampTransconductance(np: number, nn: number, cp: number, cn: number, gmRe: number, gmIm = 0): void {
    const p = this.nodeRow(np);
    const n = this.nodeRow(nn);
    const a = this.nodeRow(cp);
    const b = this.nodeRow(cn);
    this.add(p, a, gmRe, gmIm);
    this.add(p, b, -gmRe, -gmIm);
    this.add(n, a, -gmRe, -gmIm);
    this.add(n, b, gmRe, gmIm);
  }

  /** Branch incidence of an ideal source/inductor branch k between nPlus and nMinus. */
  stampBranchIncidence(nPlus: number, nMinus: number, k: number): void {
    const p = this.nodeRow(nPlus);
    const n = this.nodeRow(nMinus);
    const m = this.vsIndex(k);
    this.add(p, m, 1, 0);
    this.add(m, p, 1, 0);
    this.add(n, m, -1, 0);
    this.add(m, n, -1, 0);
  }

  /** Current phasor injected into nPlus (out of nMinus). */
  stampCurrentSource(nPlus: number, nMinus: number, re: number, im: number): void {
    this.addRHS(this.nodeRow(nPlus), re, im);
    this.addRHS(this.nodeRow(nMinus), -re, -im);
  }

  nodeVoltage(solRe: ArrayLike<number>, solIm: ArrayLike<number>, nodeIndex: number): [number, number] {
    if (nodeIndex <= 0) return [0, 0];
    return [solRe[nodeIndex - 1], solIm[nodeIndex - 1]];
  }
}
