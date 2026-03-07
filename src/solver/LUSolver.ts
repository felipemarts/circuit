/**
 * Dense LU decomposition with partial pivoting.
 * Solves Ax = b for x.
 */
export function solveLU(A: number[][], b: number[]): number[] {
  const n = A.length;
  if (n === 0) return [];

  // Copy A and b to avoid mutation
  const M = A.map(row => [...row]);
  const rhs = [...b];
  const perm = Array.from({ length: n }, (_, i) => i);

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxVal = Math.abs(M[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(M[row][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }

    if (maxVal < 1e-15) {
      throw new Error('Singular matrix: circuit may have a short circuit or disconnected node');
    }

    // Swap rows
    if (maxRow !== col) {
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      [rhs[col], rhs[maxRow]] = [rhs[maxRow], rhs[col]];
      [perm[col], perm[maxRow]] = [perm[maxRow], perm[col]];
    }

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      M[row][col] = 0;
      for (let j = col + 1; j < n; j++) {
        M[row][j] -= factor * M[col][j];
      }
      rhs[row] -= factor * rhs[col];
    }
  }

  // Back substitution
  const x = new Array<number>(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let j = row + 1; j < n; j++) {
      sum -= M[row][j] * x[j];
    }
    x[row] = sum / M[row][row];
  }

  return x;
}
