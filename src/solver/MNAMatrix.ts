import { solveLU } from './LUSolver';

/**
 * Modified Nodal Analysis matrix builder.
 *
 * Matrix layout: rows/cols 0..(nodeCount-2) are for node voltages (node indices 1..N map to matrix index 0..N-1).
 * Rows/cols (nodeCount-1)..(nodeCount-1+vsCount-1) are for voltage source currents.
 *
 * Node index 0 = ground, skipped in matrix entries.
 */
export class MNAMatrix {
  private readonly size: number;
  private readonly nodeCount: number;
  readonly G: number[][];
  readonly z: number[];

  constructor(nodeCount: number, vsourceCount: number) {
    // nodeCount includes ground (node 0), so matrix size = (nodeCount-1) + vsourceCount
    this.nodeCount = nodeCount;
    this.size = (nodeCount - 1) + vsourceCount;
    this.G = Array.from({ length: this.size }, () => new Array(this.size).fill(0));
    this.z = new Array(this.size).fill(0);
  }

  /** Map node index (1-based) to matrix row/col (0-based). Returns -1 for ground. */
  private idx(nodeIndex: number): number {
    if (nodeIndex === 0) return -1;
    return nodeIndex - 1;
  }

  /** Matrix index for a voltage source extra variable */
  vsIndex(vsNumber: number): number {
    return (this.nodeCount - 1) + vsNumber;
  }

  clear(): void {
    for (let i = 0; i < this.size; i++) {
      this.z[i] = 0;
      for (let j = 0; j < this.size; j++) {
        this.G[i][j] = 0;
      }
    }
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
    return solveLU(this.G, this.z);
  }

  /** Get node voltage from solution vector. Returns 0 for ground. */
  getNodeVoltage(solution: number[], nodeIndex: number): number {
    if (nodeIndex === 0) return 0;
    return solution[nodeIndex - 1];
  }

  /** Get voltage source current from solution vector. */
  getVSourceCurrent(solution: number[], vsNumber: number): number {
    return solution[this.vsIndex(vsNumber)];
  }
}
