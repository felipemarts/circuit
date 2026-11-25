/**
 * Landing-page hero: the LED-driver loop of bench/led-driver.bench.ts
 * (5 V · 330 Ω · LED) drawn on a canvas. Current is shown EveryCircuit-style
 * as glowing dots whose speed is proportional to the current; wires are
 * colored by node voltage; the LED glow follows the current.
 *
 * The numbers are NOT modelled here: they are the CLI's exact DC operating
 * point, copied from
 *
 *   node bin/dev.mjs verify bench/led-driver.bench.ts --json
 *     stages.op.assertions[0].measured  (D1.i) = 0.008680396325699481 A
 *     stages.op.assertions[1].measured  (led)  = 2.1354692118144647 V
 *
 * V1 is the ideal 5 V source, so R1.v = 5 − 2.13547 = 2.86453 V. The readouts
 * are therefore constant (an ideal source does not drift); only the dots move.
 */
import { voltageColor, setVoltageZeroColor } from '../ui/voltageColor';

interface Readouts {
  v1?: HTMLElement | null;
  i?: HTMLElement | null;
  vf?: HTMLElement | null;
  vr?: HTMLElement | null;
}

const W = 520;
const H = 400;

/** Operating point of bench/led-driver.bench.ts (see the header comment). */
export const LED_DRIVER_OP = {
  v1: 5,                       // V1 — ideal DC source
  i: 0.008680396325699481,     // D1.i — stages.op.assertions[0].measured
  vf: 2.1354692118144647,      // net 'led' = D1.v — stages.op.assertions[1].measured
  vr: 5 - 2.1354692118144647,  // R1.v = V1 − V(led) = 2.86453 V
} as const;

export function fmtA(i: number): string { return `${(i * 1000).toFixed(2)} mA`; }
export function fmtV(v: number): string { return `${v.toFixed(2)} V`; }

export function initHero(canvas: HTMLCanvasElement, readouts: Readouts): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let dark = true;
  let raf = 0;
  let running = false;
  let visible = true;
  let lastT = 0;
  let phase = 0;        // arc-length offset of the current dots (px)

  const fontMono = "500 12px 'JetBrains Mono', ui-monospace, monospace";
  const fontMonoSm = "500 11px 'JetBrains Mono', ui-monospace, monospace";

  function readTheme(): void {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--bg').trim();
    dark = !(document.documentElement.getAttribute('data-theme') === 'light' || (/^#f/i.test(bg)));
    setVoltageZeroColor(dark ? '#8b9bb4' : '#64748b');
  }

  function fit(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth || W;
    const ch = Math.round(cw * (H / W));
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const s = (cw / W) * dpr;
    ctx!.setTransform(s, 0, 0, s, 0, 0);
  }

  // ── Geometry (logical 520×400) ───────────────────────────────────────────
  const L = 92, R = 432, T = 72, B = 300;
  const GX = 262;
  const BATT = { top: 180, bot: 194 };
  const RES = { x1: 190, x2: 320 };
  const LED = { y: 186, half: 16 };

  // Clockwise loop: bottom-left → up the battery side → top (resistor) → down (LED) → bottom
  const segs = [
    { x1: L, y1: B, x2: L, y2: T },
    { x1: L, y1: T, x2: R, y2: T },
    { x1: R, y1: T, x2: R, y2: B },
    { x1: R, y1: B, x2: L, y2: B },
  ];
  const lens = segs.map(s => Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1));
  const PERIM = lens.reduce((a, b) => a + b, 0);

  function pointAt(d: number): { x: number; y: number; seg: number } {
    d = ((d % PERIM) + PERIM) % PERIM;
    for (let i = 0; i < segs.length; i++) {
      if (d <= lens[i]) {
        const s = segs[i];
        const t = d / lens[i];
        return { x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t, seg: i };
      }
      d -= lens[i];
    }
    return { x: L, y: B, seg: 3 };
  }

  // ── Operating point (constant; from the CLI run quoted in the header) ────
  const { v1, i, vf } = LED_DRIVER_OP;
  const vMid = vf;          // node 'led' between R1 and the LED anode
  const vTop = v1;          // battery + / resistor input node
  const vmax = 5;
  const bright = Math.max(0, Math.min(1.4, i / 0.009));   // LED halo intensity ∝ current
  const speed = i * 8900;                                  // dots: speed ∝ current (8.68 mA ≈ 77 px/s)

  // ── Drawing ──────────────────────────────────────────────────────────────
  function draw(now: number): void {
    const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0;
    lastT = now;
    if (!reduced) phase += speed * dt;

    ctx!.clearRect(0, 0, W, H);

    // LED halo (behind everything), intensity ∝ current
    const haloR = 44 + 10 * bright;
    const g = ctx!.createRadialGradient(R, LED.y, 2, R, LED.y, haloR);
    g.addColorStop(0, `rgba(251,191,36,${(0.42 * bright).toFixed(3)})`);
    g.addColorStop(0.45, `rgba(249,115,22,${(0.16 * bright).toFixed(3)})`);
    g.addColorStop(1, 'rgba(249,115,22,0)');
    ctx!.fillStyle = g;
    ctx!.beginPath(); ctx!.arc(R, LED.y, haloR, 0, Math.PI * 2); ctx!.fill();

    // Wires colored by node voltage, with a soft glow underlay
    ctx!.lineCap = 'round'; ctx!.lineJoin = 'round';
    const wireRuns: Array<{ pts: number[][]; v: number }> = [
      { pts: [[L, BATT.top], [L, T], [RES.x1, T]], v: vTop },                      // + node
      { pts: [[RES.x2, T], [R, T], [R, LED.y - LED.half]], v: vMid },              // 'led' node
      { pts: [[R, LED.y + LED.half], [R, B], [L, B], [L, BATT.bot]], v: 0 },       // ground node
    ];
    for (const run of wireRuns) {
      const col = voltageColor(run.v, vmax);
      ctx!.strokeStyle = voltageColor(run.v, vmax, dark ? 0.22 : 0.18);
      ctx!.lineWidth = 8;
      path(run.pts);
      ctx!.strokeStyle = col;
      ctx!.lineWidth = 2.4;
      path(run.pts);
    }

    // Ground symbol
    ctx!.strokeStyle = dark ? '#8b9bb4' : '#64748b';
    ctx!.lineWidth = 2.2;
    path([[GX, B], [GX, B + 22]]);
    path([[GX - 18, B + 22], [GX + 18, B + 22]]);
    path([[GX - 11, B + 29], [GX + 11, B + 29]]);
    path([[GX - 4, B + 36], [GX + 4, B + 36]]);
    dot(GX, B, 3.2, voltageColor(0, vmax));

    // Battery: long thin plate (+) and short thick plate (−)
    const ink = dark ? '#e8eef8' : '#0f172a';
    ctx!.strokeStyle = ink;
    ctx!.lineWidth = 2.2;
    path([[L - 16, BATT.top], [L + 16, BATT.top]]);
    ctx!.lineWidth = 5.5;
    path([[L - 8, BATT.bot], [L + 8, BATT.bot]]);

    // Resistor: zig-zag body
    ctx!.lineWidth = 2.4;
    ctx!.strokeStyle = ink;
    const zw = RES.x2 - RES.x1, amp = 9;
    const zig: number[][] = [[0, 0], [1, -1], [3, 1], [5, -1], [7, 1], [9, -1], [11, 1], [12, 0]];
    path(zig.map(p => [RES.x1 + zw * p[0] / 12, T + amp * p[1]]));

    // LED: triangle + bar, body tinted warm when lit
    ctx!.strokeStyle = ink;
    ctx!.lineWidth = 2.4;
    ctx!.beginPath();
    ctx!.moveTo(R - 13, LED.y - LED.half); ctx!.lineTo(R + 13, LED.y - LED.half); ctx!.lineTo(R, LED.y + LED.half - 2); ctx!.closePath();
    ctx!.fillStyle = `rgba(251,191,36,${(0.18 + 0.5 * bright).toFixed(3)})`;
    ctx!.fill(); ctx!.stroke();
    path([[R - 13, LED.y + LED.half - 2], [R + 13, LED.y + LED.half - 2]]);
    // emission arrows
    ctx!.strokeStyle = `rgba(251,191,36,${(0.35 + 0.6 * bright).toFixed(3)})`;
    ctx!.lineWidth = 1.7;
    for (const a of [[R + 18, LED.y - 20, R + 30, LED.y - 32], [R + 25, LED.y - 10, R + 37, LED.y - 22]]) {
      path([[a[0], a[1]], [a[2], a[3]]]);
      path([[a[2], a[3]], [a[2] - 6, a[3] + 1]]);
      path([[a[2], a[3]], [a[2] - 1, a[3] + 6]]);
    }

    // Labels
    ctx!.textBaseline = 'middle';
    ctx!.fillStyle = dark ? '#9aa8bf' : '#475569';
    ctx!.font = fontMono;
    ctx!.textAlign = 'right';
    ctx!.fillText('V1', L - 26, BATT.top - 6);
    ctx!.fillText(fmtV(v1), L - 26, BATT.top + 12);
    ctx!.textAlign = 'left';
    ctx!.fillText('+', L + 22, BATT.top - 2);
    ctx!.fillText('R1  330 Ω', RES.x1 + 6, T - 22);
    ctx!.fillText('D1', R - 56, LED.y - 2);
    ctx!.font = fontMonoSm;
    ctx!.fillStyle = dark ? '#6b7a93' : '#6b7a93';
    ctx!.fillText('gnd', GX + 26, B + 28);
    // node voltage tags
    tag(RES.x2 + 22, T + 20, fmtV(vMid), voltageColor(vMid, vmax));
    tag(L + 22, T + 20, fmtV(vTop), voltageColor(vTop, vmax));

    // Current dots (EveryCircuit signature) — halo + core, no shadowBlur
    const N = 14;
    const dotCol = dark ? '#fef3c7' : '#b45309';
    const halo = dark ? 'rgba(251,191,36,0.28)' : 'rgba(217,119,6,0.22)';
    for (let k = 0; k < N; k++) {
      const p = pointAt(phase + k * (PERIM / N));
      // hide dots inside component bodies
      if (p.seg === 0 && p.y > BATT.top - 2 && p.y < BATT.bot + 2) continue;
      if (p.seg === 1 && p.x > RES.x1 - 2 && p.x < RES.x2 + 2) continue;
      if (p.seg === 2 && p.y > LED.y - LED.half - 2 && p.y < LED.y + LED.half) continue;
      dot(p.x, p.y, 6.5, halo);
      dot(p.x, p.y, 2.9, dotCol);
    }
  }

  function path(pts: number[][]): void {
    ctx!.beginPath();
    ctx!.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) ctx!.lineTo(pts[k][0], pts[k][1]);
    ctx!.stroke();
  }
  function dot(x: number, y: number, r: number, fill: string): void {
    ctx!.fillStyle = fill;
    ctx!.beginPath(); ctx!.arc(x, y, r, 0, Math.PI * 2); ctx!.fill();
  }
  function tag(x: number, y: number, text: string, color: string): void {
    ctx!.font = fontMonoSm;
    const w = ctx!.measureText(text).width + 14;
    ctx!.fillStyle = dark ? 'rgba(7,11,20,0.85)' : 'rgba(255,255,255,0.9)';
    roundRect(x - 7, y - 10, w, 20, 6);
    ctx!.fill();
    ctx!.strokeStyle = color; ctx!.lineWidth = 1; ctx!.stroke();
    ctx!.fillStyle = color; ctx!.textAlign = 'left';
    ctx!.fillText(text, x, y + 0.5);
  }
  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx!.beginPath();
    ctx!.moveTo(x + r, y); ctx!.lineTo(x + w - r, y); ctx!.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx!.lineTo(x + w, y + h - r); ctx!.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx!.lineTo(x + r, y + h); ctx!.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx!.lineTo(x, y + r); ctx!.quadraticCurveTo(x, y, x + r, y); ctx!.closePath();
  }

  // ── Loop control ─────────────────────────────────────────────────────────
  function frame(now: number): void {
    if (!running) return;
    draw(now);
    raf = requestAnimationFrame(frame);
  }
  function start(): void {
    if (running || reduced || !visible || document.hidden) return;
    running = true; lastT = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop(): void {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // DOM readouts: written once — the operating point is constant.
  if (readouts.v1) readouts.v1.textContent = fmtV(v1);
  if (readouts.i) readouts.i.textContent = fmtA(i);
  if (readouts.vf) readouts.vf.textContent = fmtV(vf);
  if (readouts.vr) readouts.vr.textContent = fmtV(LED_DRIVER_OP.vr);

  readTheme();
  fit();
  draw(performance.now());
  if (!reduced) start();

  const onResize = () => { fit(); draw(performance.now()); };
  const onTheme = () => { readTheme(); draw(performance.now()); };
  const onVis = () => { if (document.hidden) stop(); else start(); };
  window.addEventListener('resize', onResize);
  window.addEventListener('cv-theme', onTheme);
  document.addEventListener('visibilitychange', onVis);
  let io: IntersectionObserver | null = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(entries => {
      visible = entries.some(e => e.isIntersecting);
      if (visible) start(); else stop();
    }, { threshold: 0.05 });
    io.observe(canvas);
  }

  return () => {
    stop();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('cv-theme', onTheme);
    document.removeEventListener('visibilitychange', onVis);
    io?.disconnect();
  };
}
