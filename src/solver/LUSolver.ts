/**
 * Dense LU decomposition with partial pivoting (real and complex).
 *
 * Pivot choice is deterministic: the largest |a| in the column wins and ties
 * go to the lowest row index, so the same matrix always factors the same way.
 */

const SINGULAR_PIVOT = 1e-15;

export class SingularMatrixError extends Error {
  /** Matrix row/column (0-based unknown index) where elimination broke down. */
  readonly column: number;
  constructor(column: number) {
    super('Singular matrix: circuit may have a short circuit or disconnected node');
    this.name = 'SingularMatrixError';
    this.column = column;
  }
}

type Matrix = ArrayLike<number>[] | number[][];

/** Solves Ax = b for x. A and b are not mutated. */
export function solveLU(A: Matrix, b: ArrayLike<number>): number[] {
  const n = A.length;
  if (n === 0) return [];
  const M: Float64Array[] = [];
  for (let i = 0; i < n; i++) M.push(Float64Array.from(A[i] as ArrayLike<number>));
  const rhs = Float64Array.from(b);
  luSolveInPlace(M, rhs);
  return Array.from(rhs);
}

/**
 * Factor M in place and overwrite rhs with the solution. M is destroyed.
 * Throws SingularMatrixError on a (numerically) zero pivot.
 */
export function luSolveInPlace(M: Float64Array[], rhs: Float64Array): void {
  const n = M.length;
  for (let col = 0; col < n; col++) {
    let maxVal = Math.abs(M[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(M[row][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }
    if (!(maxVal >= SINGULAR_PIVOT)) throw new SingularMatrixError(col);
    if (maxRow !== col) {
      const tmp = M[col];
      M[col] = M[maxRow];
      M[maxRow] = tmp;
      const t = rhs[col];
      rhs[col] = rhs[maxRow];
      rhs[maxRow] = t;
    }
    const pivotRow = M[col];
    const pivot = pivotRow[col];
    for (let row = col + 1; row < n; row++) {
      const r = M[row];
      const a = r[col];
      if (a === 0) continue;
      const factor = a / pivot;
      r[col] = 0;
      for (let j = col + 1; j < n; j++) r[j] -= factor * pivotRow[j];
      rhs[row] -= factor * rhs[col];
    }
  }
  for (let row = n - 1; row >= 0; row--) {
    const r = M[row];
    let sum = rhs[row];
    for (let j = row + 1; j < n; j++) sum -= r[j] * rhs[j];
    rhs[row] = sum / r[row];
  }
}

/**
 * Complex dense LU with partial pivoting. Real and imaginary parts are kept in
 * separate row arrays (re[i][j] + j·im[i][j]); rhs likewise. Solves in place.
 */
export function complexLuSolveInPlace(
  re: Float64Array[],
  im: Float64Array[],
  bRe: Float64Array,
  bIm: Float64Array,
): void {
  const n = re.length;
  for (let col = 0; col < n; col++) {
    let maxVal = Math.hypot(re[col][col], im[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.hypot(re[row][col], im[row][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }
    if (!(maxVal >= SINGULAR_PIVOT)) throw new SingularMatrixError(col);
    if (maxRow !== col) {
      let tmp = re[col];
      re[col] = re[maxRow];
      re[maxRow] = tmp;
      tmp = im[col];
      im[col] = im[maxRow];
      im[maxRow] = tmp;
      let t = bRe[col];
      bRe[col] = bRe[maxRow];
      bRe[maxRow] = t;
      t = bIm[col];
      bIm[col] = bIm[maxRow];
      bIm[maxRow] = t;
    }
    const pr = re[col];
    const pi = im[col];
    const den = pr[col] * pr[col] + pi[col] * pi[col];
    // 1 / pivot
    const invRe = pr[col] / den;
    const invIm = -pi[col] / den;
    for (let row = col + 1; row < n; row++) {
      const rr = re[row];
      const ri = im[row];
      const aRe = rr[col];
      const aIm = ri[col];
      if (aRe === 0 && aIm === 0) continue;
      // factor = a / pivot
      const fRe = aRe * invRe - aIm * invIm;
      const fIm = aRe * invIm + aIm * invRe;
      rr[col] = 0;
      ri[col] = 0;
      for (let j = col + 1; j < n; j++) {
        const pRe = pr[j];
        const pIm = pi[j];
        if (pRe === 0 && pIm === 0) continue;
        rr[j] -= fRe * pRe - fIm * pIm;
        ri[j] -= fRe * pIm + fIm * pRe;
      }
      const cRe = bRe[col];
      const cIm = bIm[col];
      bRe[row] -= fRe * cRe - fIm * cIm;
      bIm[row] -= fRe * cIm + fIm * cRe;
    }
  }
  for (let row = n - 1; row >= 0; row--) {
    const rr = re[row];
    const ri = im[row];
    let sRe = bRe[row];
    let sIm = bIm[row];
    for (let j = row + 1; j < n; j++) {
      const aRe = rr[j];
      const aIm = ri[j];
      if (aRe === 0 && aIm === 0) continue;
      sRe -= aRe * bRe[j] - aIm * bIm[j];
      sIm -= aRe * bIm[j] + aIm * bRe[j];
    }
    const dRe = rr[row];
    const dIm = ri[row];
    const den = dRe * dRe + dIm * dIm;
    bRe[row] = (sRe * dRe + sIm * dIm) / den;
    bIm[row] = (sIm * dRe - sRe * dIm) / den;
  }
}
