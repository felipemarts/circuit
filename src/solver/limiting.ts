/**
 * Newton-Raphson voltage limiting (SPICE3 DEVpnjlim / DEVfetlim / DEVlimvds).
 *
 * A device calls these from its `load()` with the voltage the solver proposes
 * (`vnew`) and the voltage it used on the previous iteration (`vold`). When
 * the step is clamped the device must report it with `ctx.limited()`, so the
 * iteration is not declared converged on a limited (not yet self-consistent)
 * point.
 */

/** Critical voltage of a pn junction: where the exponential's curvature takes over. */
export function junctionVcrit(nVt: number, Is: number): number {
  return nVt * Math.log(nVt / (Math.SQRT2 * Is));
}

/** Result of a limiting call: the voltage to linearize around and whether it was clamped. */
export interface Limited {
  value: number;
  limited: boolean;
}

/**
 * pn-junction limiting: above vcrit, a forward step larger than 2·nVt is
 * replaced by a logarithmic step, which keeps exp() finite and makes NR walk
 * up the exponential instead of overshooting it.
 */
export function pnjlim(vnew: number, vold: number, nVt: number, vcrit: number): Limited {
  if (vnew > vcrit && Math.abs(vnew - vold) > nVt + nVt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / nVt;
      return { value: arg > 0 ? vold + nVt * Math.log(arg) : vcrit, limited: true };
    }
    return { value: nVt * Math.log(vnew / nVt), limited: true };
  }
  return { value: vnew, limited: false };
}

/** MOSFET gate-source limiting around the threshold `vto` (for future FET models). */
export function fetlim(vnew: number, vold: number, vto: number): Limited {
  const vtsthi = Math.abs(2 * (vold - vto)) + 2;
  const vtstlo = vtsthi / 2 + 2;
  const vtox = vto + 3.5;
  const delv = vnew - vold;
  let v = vnew;
  if (vold >= vto) {
    if (vold >= vtox) {
      if (delv <= 0) {
        if (vnew >= vtox) {
          if (-delv > vtstlo) v = vold - vtstlo;
        } else {
          v = Math.max(vnew, vto + 2);
        }
      } else if (delv >= vtsthi) {
        v = vold + vtsthi;
      }
    } else if (delv <= 0) {
      v = Math.max(vnew, vto - 0.5);
    } else {
      v = Math.min(vnew, vto + 4);
    }
  } else if (delv <= 0) {
    if (-delv > vtsthi) v = vold - vtsthi;
  } else {
    const vtemp = vto + 0.5;
    if (vnew <= vtemp) {
      if (delv > vtstlo) v = vold + vtstlo;
    } else {
      v = vtemp;
    }
  }
  return { value: v, limited: v !== vnew };
}

/** MOSFET drain-source limiting (for future FET models). */
export function limvds(vnew: number, vold: number): Limited {
  let v = vnew;
  if (vold >= 3.5) {
    if (vnew > vold) v = Math.min(vnew, 3 * vold + 2);
    else if (vnew < 3.5) v = Math.max(vnew, 2);
  } else if (vnew > vold) {
    v = Math.min(vnew, 4);
  } else {
    v = Math.max(vnew, -0.5);
  }
  return { value: v, limited: v !== vnew };
}

/** exp() that continues linearly past x = 700, so no model ever produces Infinity. */
export function safeExp(x: number): number {
  const MAX = 700;
  if (x <= MAX) return Math.exp(x);
  return Math.exp(MAX) * (1 + (x - MAX));
}
