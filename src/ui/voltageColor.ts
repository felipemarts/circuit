/**
 * Voltage → color scale shared by the simulator canvas and the landing-page
 * hero animation. Diverging palette: negative voltages go blue → violet,
 * zero is a neutral slate, positive voltages go amber → red.
 *
 * `t = v / vmax` is clamped to [-1, 1]; the stops are interpolated in sRGB.
 */

type RGB = [number, number, number];

const STOPS: Array<{ t: number; c: RGB }> = [
  { t: -1.0, c: [139, 92, 246] },  // violet  #8b5cf6
  { t: -0.5, c: [59, 130, 246] },  // blue    #3b82f6
  { t: 0.0, c: [148, 163, 184] },  // slate   #94a3b8 (overridden per theme)
  { t: 0.5, c: [245, 158, 11] },   // amber   #f59e0b
  { t: 1.0, c: [239, 68, 68] },    // red     #ef4444
];

let zeroColor: RGB = [148, 163, 184];

/** Set the color used for 0 V (themes use a darker slate on light backgrounds). */
export function setVoltageZeroColor(hex: string): void {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return;
  const n = parseInt(m[1], 16);
  zeroColor = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function voltageRGB(v: number, vmax: number): RGB {
  if (!(vmax > 0) || !Number.isFinite(v)) return zeroColor;
  const t = Math.max(-1, Math.min(1, v / vmax));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i];
    const b = STOPS[i + 1];
    if (t >= a.t && t <= b.t) {
      const ca = a.t === 0 ? zeroColor : a.c;
      const cb = b.t === 0 ? zeroColor : b.c;
      const k = (t - a.t) / (b.t - a.t);
      return [
        Math.round(lerp(ca[0], cb[0], k)),
        Math.round(lerp(ca[1], cb[1], k)),
        Math.round(lerp(ca[2], cb[2], k)),
      ];
    }
  }
  return zeroColor;
}

export function voltageColor(v: number, vmax: number, alpha = 1): string {
  const [r, g, b] = voltageRGB(v, vmax);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** CSS linear-gradient string spanning −vmax … +vmax (for legends). */
export function voltageGradientCSS(symmetric = true): string {
  const parts: string[] = [];
  const stops = symmetric ? STOPS : STOPS.filter(s => s.t >= 0);
  const lo = stops[0].t;
  const hi = stops[stops.length - 1].t;
  for (const s of stops) {
    const c = s.t === 0 ? zeroColor : s.c;
    const pct = ((s.t - lo) / (hi - lo)) * 100;
    parts.push(`rgb(${c[0]},${c[1]},${c[2]}) ${pct.toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** Pick a "nice" full-scale value for a legend from the observed |v| max. */
export function niceVoltageScale(maxAbs: number): number {
  if (!(maxAbs > 0)) return 1;
  const exp = Math.floor(Math.log10(maxAbs));
  const base = Math.pow(10, exp);
  const m = maxAbs / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * base;
}
