/** Exact RC low-pass response to a piecewise-linear input (zero initial state). */
export function rcExact(tau: number, corners: [number, number][], t: number): number {
  // input is linear between corners; before first corner = first value
  let v = 0, tc = 0, uc = corners[0][1];
  // initial: from t=0 to first corner input constant uc
  const segs: [number, number, number, number][] = [];
  let prevT = 0, prevU = corners[0][1];
  for (const [ct, cu] of corners) { if (ct > prevT) segs.push([prevT, prevU, ct, cu]); prevT = ct; prevU = cu; }
  segs.push([prevT, prevU, Infinity, prevU]);
  for (const [t0, u0, t1, u1] of segs) {
    const end = Math.min(t, t1);
    if (end <= t0) break;
    const a = t1 === Infinity ? 0 : (u1 - u0) / (t1 - t0); // slope
    const dt = end - t0;
    // v' = (u0 + a s - v)/tau ; solution
    const e = Math.exp(-dt / tau);
    v = (u0 - a * tau) + a * dt + (v - (u0 - a * tau)) * e;
    if (end === t) break;
  }
  return v;
}
