import { describe, it, expect } from 'vitest';
import { solveLU } from '../../src/solver/LUSolver';

describe('LUSolver', () => {
  it('solves identity system', () => {
    const A = [[1, 0], [0, 1]];
    const b = [3, 7];
    const x = solveLU(A, b);
    expect(x[0]).toBeCloseTo(3);
    expect(x[1]).toBeCloseTo(7);
  });

  it('solves 2x2 system', () => {
    // 2x + y = 5
    // x + 3y = 7
    const A = [[2, 1], [1, 3]];
    const b = [5, 7];
    const x = solveLU(A, b);
    expect(x[0]).toBeCloseTo(1.6);  // x = 8/5
    expect(x[1]).toBeCloseTo(1.8);  // y = 9/5
  });

  it('solves 3x3 system', () => {
    const A = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const b = [8, -11, -3];
    const x = solveLU(A, b);
    expect(x[0]).toBeCloseTo(2);
    expect(x[1]).toBeCloseTo(3);
    expect(x[2]).toBeCloseTo(-1);
  });

  it('handles system requiring pivoting', () => {
    // First pivot element is zero
    const A = [[0, 1], [1, 0]];
    const b = [3, 7];
    const x = solveLU(A, b);
    expect(x[0]).toBeCloseTo(7);
    expect(x[1]).toBeCloseTo(3);
  });

  it('throws on singular matrix', () => {
    const A = [[1, 1], [1, 1]];
    const b = [2, 2];
    expect(() => solveLU(A, b)).toThrow('Singular');
  });

  it('handles empty system', () => {
    expect(solveLU([], [])).toEqual([]);
  });
});
