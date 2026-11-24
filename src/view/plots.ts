/**
 * Canvas plots for the viewer panels: scope (transient traces with pass/fail
 * bands), Bode (gain + phase, log f, markers), DC sweep curve with markers,
 * and a logic analyzer (0/1/X/Z with edges, markers and a time cursor).
 * Theme colors come from CSS variables on the canvas element.
 */
import { eng } from './format';
import type { BodeCurve, DcCurveModel, LogicModel, ScopeModel } from './models';
import { logicAt } from './models';

export interface Theme {
  fg: string;
  muted: string;
  dim: string;
  grid: string;
  pass: string;
  fail: string;
  accent: string;
  accent2: string;
  amber: string;
  series: string[];
  font: string;
  logic1: string;
  logic0: string;
  logicX: string;
  logicZ: string;
}

export function themeOf(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const accent = v('--accent', '#22d3ee');
  const accent2 = v('--accent-2', '#a78bfa');
  const amber = v('--amber', '#fbbf24');
  const green = v('--green', '#34d399');
  const blue = v('--blue', '#60a5fa');
  const red = v('--red', '#fb7185');
  return {
    fg: v('--text', '#e8eef8'),
    muted: v('--muted', '#9aa8bf'),
    dim: v('--dim', '#6b7a93'),
    grid: v('--border', 'rgba(148,163,184,0.14)'),
    pass: green,
    fail: red,
    accent,
    accent2,
    amber,
    series: [accent, amber, accent2, green, blue, '#f472b6', '#fb923c', '#2dd4bf'],
    font: `11px ${v('--mono', 'ui-monospace, monospace')}`,
    logic1: v('--logic-1', amber),
    logic0: v('--logic-0', '#64748b'),
    logicX: v('--logic-x', red),
    logicZ: v('--logic-z', '#6b7a93'),
  };
}

interface Ctx {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  th: Theme;
}

function begin(canvas: HTMLCanvasElement, height: number): Ctx {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.max(200, canvas.clientWidth || canvas.parentElement?.clientWidth || 600);
  canvas.style.height = `${height}px`;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, height);
  const th = themeOf(canvas);
  ctx.font = th.font;
  return { ctx, W, H: height, th };
}

/** Nice tick values between lo and hi (≈ n ticks). */
function ticks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function range(ys: number[], pad = 0.08): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const y of ys) {
    if (!Number.isFinite(y)) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  if (!Number.isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-12) {
    const d = Math.max(Math.abs(hi) * 0.1, 1e-9);
    return [lo - d, hi + d];
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

const LEFT = 58;
const RIGHT = 14;

// ─── scope ───────────────────────────────────────────────────────────────────

export interface ScopeOpts {
  cursorT?: number;
  hoverX?: number | null;
  rowHeight?: number;
}

export const scopeHeight = (model: ScopeModel, rowHeight = 96): number => model.traces.length * rowHeight + 26;

export function drawScope(canvas: HTMLCanvasElement, model: ScopeModel, opts: ScopeOpts = {}): { hoverT?: number } {
  const rowH = opts.rowHeight ?? 96;
  const { ctx, W, th } = begin(canvas, scopeHeight(model, rowH));
  const x0 = LEFT;
  const x1 = W - RIGHT;
  const tEnd = model.tstop;
  const tx = (t: number) => x0 + ((x1 - x0) * t) / tEnd;
  const result: { hoverT?: number } = {};
  const hoverT = opts.hoverX !== undefined && opts.hoverX !== null && opts.hoverX >= x0 && opts.hoverX <= x1 ? ((opts.hoverX - x0) / (x1 - x0)) * tEnd : undefined;
  if (hoverT !== undefined) result.hoverT = hoverT;

  model.traces.forEach((tr, row) => {
    const top = row * rowH + 8;
    const bottom = top + rowH - 26;
    const bandYs = tr.bands.flatMap(b => [b.y, b.lo, b.hi].filter((v): v is number => v !== undefined && Number.isFinite(v)));
    const [lo, hi] = range([...tr.y, ...bandYs]);
    const ty = (y: number) => bottom - ((bottom - top) * (y - lo)) / (hi - lo);
    // frame + grid
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x0, top, x1 - x0, bottom - top);
    ctx.stroke();
    ctx.fillStyle = th.dim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ticks(lo, hi, 3)) {
      const y = ty(v);
      if (y < top - 1 || y > bottom + 1) continue;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.strokeStyle = th.grid;
      ctx.stroke();
      ctx.fillText(eng(v, tr.unit, 2), x0 - 6, y);
    }
    // bands
    for (const b of tr.bands) {
      const col = b.verdict === 'pass' ? th.pass : th.fail;
      const fx0 = tx(b.from ?? 0);
      const fx1 = tx(b.to ?? tEnd);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, top, x1 - x0, bottom - top);
      ctx.clip();
      if (b.kind === 'line' && b.y !== undefined && Number.isFinite(b.y)) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(fx0, ty(b.y));
        ctx.lineTo(fx1, ty(b.y));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.textAlign = 'right';
        const ly = ty(b.y);
        ctx.fillText(b.label, x1 - 6, ly < (top + bottom) / 2 ? ly + 12 : ly - 6);
      } else if (b.kind === 'region') {
        // forbidden region
        const yl = ty(Number.isFinite(b.hi!) ? b.hi! : hi + (hi - lo));
        const yh = ty(Number.isFinite(b.lo!) ? b.lo! : lo - (hi - lo));
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(fx0, Math.min(yl, yh), fx1 - fx0, Math.abs(yh - yl));
        ctx.globalAlpha = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = col;
        ctx.beginPath();
        const edge = Number.isFinite(b.hi!) ? ty(b.hi!) : ty(b.lo!);
        ctx.moveTo(fx0, edge);
        ctx.lineTo(fx1, edge);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = 'right';
        ctx.fillText(b.label, x1 - 6, Number.isFinite(b.hi!) ? edge + 12 : edge - 6);
      } else if (b.kind === 'band' && b.lo !== undefined && b.hi !== undefined) {
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(fx0, ty(b.hi), fx1 - fx0, ty(b.lo) - ty(b.hi));
        ctx.globalAlpha = 1;
        ctx.textAlign = 'right';
        ctx.fillText(b.label, x1 - 6, ty(b.hi) - 6);
      }
      ctx.restore();
    }
    // trace
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, top, x1 - x0, bottom - top);
    ctx.clip();
    ctx.strokeStyle = tr.verdict === 'fail' ? th.fail : tr.verdict === 'pass' ? th.pass : th.series[row % th.series.length];
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < tr.t.length; k++) {
      const y = tr.y[k];
      if (!Number.isFinite(y)) continue;
      const px = tx(tr.t[k]);
      const py = ty(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    if (tr.tFirstViolation !== undefined) {
      ctx.fillStyle = th.fail;
      ctx.beginPath();
      ctx.arc(tx(tr.tFirstViolation), top + 6, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = th.fail;
      ctx.lineWidth = 1;
      ctx.moveTo(tx(tr.tFirstViolation), top);
      ctx.lineTo(tx(tr.tFirstViolation), bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    // title
    ctx.fillStyle = th.fg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${th.font}`;
    ctx.fillText(tr.probe, x0 + 6, top + 13);
    ctx.font = th.font;
    if (tr.verdict !== 'none') {
      ctx.fillStyle = tr.verdict === 'pass' ? th.pass : th.fail;
      ctx.fillText(tr.verdict === 'pass' ? '✓' : '✗', x0 + 8 + ctx.measureText(tr.probe).width + 6, top + 13);
    }
    // cursor + readout
    const cur = hoverT ?? opts.cursorT;
    if (cur !== undefined) {
      const k = indexOf(tr.t, cur);
      const v = tr.y[k];
      const cx = tx(cur);
      ctx.strokeStyle = th.accent;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.lineTo(cx, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (Number.isFinite(v)) {
        ctx.fillStyle = th.accent;
        ctx.beginPath();
        ctx.arc(cx, ty(v), 3, 0, Math.PI * 2);
        ctx.fill();
        const txt = eng(v, tr.unit);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = th.accent;
        ctx.font = `600 ${th.font}`;
        ctx.fillText(txt, x0 + 8 + ctx.measureText(tr.probe).width + 26, top + 13);
        ctx.font = th.font;
      }
    }
  });
  // time axis
  const axY = model.traces.length * rowH + 8;
  ctx.fillStyle = th.dim;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const v of ticks(0, tEnd, 6)) ctx.fillText(eng(v, 's', 2), tx(v), axY + 10);
  return result;
}

function indexOf(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ─── bode ────────────────────────────────────────────────────────────────────

export const bodeHeight = 300;

export function drawBode(canvas: HTMLCanvasElement, curves: BodeCurve[], opts: { hoverX?: number | null } = {}): void {
  const { ctx, W, th } = begin(canvas, bodeHeight);
  if (curves.length === 0) return;
  const x0 = LEFT;
  const x1 = W - RIGHT;
  const fMin = Math.min(...curves.map(c => c.f[0]));
  const fMax = Math.max(...curves.map(c => c.f[c.f.length - 1]));
  const lx = (f: number) => x0 + ((x1 - x0) * (Math.log10(f) - Math.log10(fMin))) / (Math.log10(fMax) - Math.log10(fMin));
  const panes: { top: number; bottom: number; key: 'gain' | 'phase'; unit: string }[] = [
    { top: 10, bottom: 160, key: 'gain', unit: 'dB' },
    { top: 178, bottom: 272, key: 'phase', unit: '°' },
  ];
  const hoverF = opts.hoverX !== undefined && opts.hoverX !== null && opts.hoverX >= x0 && opts.hoverX <= x1 ? Math.pow(10, Math.log10(fMin) + ((opts.hoverX - x0) / (x1 - x0)) * (Math.log10(fMax) - Math.log10(fMin))) : undefined;
  for (const pane of panes) {
    const all = curves.flatMap(c => [...c[pane.key], ...c.markers.map(m => (pane.key === 'gain' ? m.gain : m.phase)).filter((v): v is number => v !== undefined)]);
    const [lo, hi] = range(all, 0.1);
    const ty = (v: number) => pane.bottom - ((pane.bottom - pane.top) * (v - lo)) / (hi - lo);
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x0, pane.top, x1 - x0, pane.bottom - pane.top);
    ctx.stroke();
    // decade grid
    for (let d = Math.ceil(Math.log10(fMin)); d <= Math.floor(Math.log10(fMax)); d++) {
      const x = lx(Math.pow(10, d));
      ctx.beginPath();
      ctx.moveTo(x, pane.top);
      ctx.lineTo(x, pane.bottom);
      ctx.stroke();
    }
    ctx.fillStyle = th.dim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ticks(lo, hi, 4)) {
      const y = ty(v);
      if (y < pane.top || y > pane.bottom) continue;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.fillText(pane.key === 'gain' ? `${Math.round(v)} dB` : `${Math.round(v)}°`, x0 - 6, y);
    }
    curves.forEach((c, k) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, pane.top, x1 - x0, pane.bottom - pane.top);
      ctx.clip();
      ctx.strokeStyle = th.series[k % th.series.length];
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      c.f.forEach((f, i) => {
        const v = c[pane.key][i];
        if (!Number.isFinite(v)) return;
        if (i === 0) ctx.moveTo(lx(f), ty(v));
        else ctx.lineTo(lx(f), ty(v));
      });
      ctx.stroke();
      let mk = 0;
      for (const m of c.markers) {
        const v = pane.key === 'gain' ? m.gain : m.phase;
        if (v === undefined) continue;
        mk++;
        const col = m.verdict === 'pass' ? th.pass : th.fail;
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx(m.f), pane.top);
        ctx.lineTo(lx(m.f), pane.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(lx(m.f), ty(v), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = lx(m.f) > (x0 + x1) / 2 ? 'right' : 'left';
        ctx.textBaseline = 'alphabetic';
        // Labels in a staggered row under the pane top so neighbouring markers never collide.
        ctx.fillText(`${m.verdict === 'pass' ? '✓' : '✗'} ${m.label}`, lx(m.f) + (ctx.textAlign === 'left' ? 5 : -5), pane.bottom - 8 - ((mk - 1) % 3) * 12);
      }
      ctx.restore();
    });
    if (hoverF !== undefined) {
      const hx = lx(hoverF);
      ctx.strokeStyle = th.accent;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(hx, pane.top);
      ctx.lineTo(hx, pane.bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      curves.forEach((c, k) => {
        const v = interpLogArr(c.f, c[pane.key], hoverF);
        if (!Number.isFinite(v)) return;
        ctx.fillStyle = th.series[k % th.series.length];
        ctx.beginPath();
        ctx.arc(hx, ty(v), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = th.fg;
        ctx.fillText(`${c.probe}${c.ref ? `/${c.ref}` : ''}: ${pane.key === 'gain' ? `${v.toFixed(2)} dB` : `${v.toFixed(1)}°`} @ ${eng(hoverF, 'Hz')}`, x1 - 6, pane.top + 13 + k * 13);
      });
    }
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(pane.key === 'gain' ? 'gain' : 'phase', x0 + 6, pane.top + 13);
  }
  ctx.fillStyle = th.dim;
  ctx.textAlign = 'center';
  for (let d = Math.ceil(Math.log10(fMin)); d <= Math.floor(Math.log10(fMax)); d++) ctx.fillText(eng(Math.pow(10, d), 'Hz', 1), lx(Math.pow(10, d)), 290);
}

function interpLogArr(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  for (let k = 1; k < xs.length; k++) {
    if (x <= xs[k]) {
      const f = (Math.log(x) - Math.log(xs[k - 1])) / (Math.log(xs[k]) - Math.log(xs[k - 1]));
      return ys[k - 1] + (ys[k] - ys[k - 1]) * f;
    }
  }
  return ys[ys.length - 1];
}

// ─── dc sweep ────────────────────────────────────────────────────────────────

export const dcHeight = 220;

export function drawDc(canvas: HTMLCanvasElement, curves: DcCurveModel[], opts: { hoverX?: number | null } = {}): void {
  const { ctx, W, th } = begin(canvas, dcHeight);
  if (curves.length === 0) return;
  const x0 = LEFT;
  const x1 = W - RIGHT;
  const top = 10;
  const bottom = dcHeight - 28;
  const xs = curves.flatMap(c => c.x);
  const [xlo, xhi] = [Math.min(...xs), Math.max(...xs)];
  const [lo, hi] = range(curves.flatMap(c => [...c.y, ...c.markers.map(m => m.y).filter((v): v is number => v !== undefined && Number.isFinite(v))]), 0.1);
  const tx = (x: number) => x0 + ((x1 - x0) * (x - xlo)) / (xhi - xlo || 1);
  const ty = (v: number) => bottom - ((bottom - top) * (v - lo)) / (hi - lo);
  ctx.strokeStyle = th.grid;
  ctx.beginPath();
  ctx.rect(x0, top, x1 - x0, bottom - top);
  ctx.stroke();
  ctx.fillStyle = th.dim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const unit = curves[0].unit;
  for (const v of ticks(lo, hi, 4)) {
    const y = ty(v);
    if (y < top || y > bottom) continue;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillText(eng(v, unit, 2), x0 - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const v of ticks(xlo, xhi, 6)) {
    ctx.beginPath();
    ctx.moveTo(tx(v), top);
    ctx.lineTo(tx(v), bottom);
    ctx.stroke();
    ctx.fillText(eng(v, '', 2), tx(v), bottom + 14);
  }
  ctx.fillText(curves[0].xLabel, (x0 + x1) / 2, dcHeight - 4);
  const hoverX = opts.hoverX !== undefined && opts.hoverX !== null && opts.hoverX >= x0 && opts.hoverX <= x1 ? xlo + ((opts.hoverX - x0) / (x1 - x0)) * (xhi - xlo) : undefined;
  curves.forEach((c, k) => {
    ctx.strokeStyle = th.series[k % th.series.length];
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    c.x.forEach((x, i) => (i === 0 ? ctx.moveTo(tx(x), ty(c.y[i])) : ctx.lineTo(tx(x), ty(c.y[i]))));
    ctx.stroke();
    ctx.fillStyle = th.fg;
    ctx.textAlign = 'left';
    ctx.fillText(c.probe, x0 + 6 + k * 70, top + 13);
    for (const m of c.markers) {
      const col = m.verdict === 'pass' ? th.pass : th.fail;
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      if (m.x !== undefined && Number.isFinite(m.x)) {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(tx(m.x), top);
        ctx.lineTo(tx(m.x), bottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (m.x !== undefined && m.y !== undefined && Number.isFinite(m.x) && Number.isFinite(m.y)) {
        ctx.beginPath();
        ctx.arc(tx(m.x), ty(m.y), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = tx(m.x) > (x0 + x1) / 2 ? 'right' : 'left';
        ctx.fillText(`${m.verdict === 'pass' ? '✓' : '✗'} ${m.label}`, tx(m.x) + (ctx.textAlign === 'left' ? 7 : -7), ty(m.y) - 8);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(`${m.verdict === 'pass' ? '✓' : '✗'} ${m.label}`, x1 - 6, top + 13);
      }
    }
    if (hoverX !== undefined) {
      const v = interpLinArr(c.x, c.y, hoverX);
      ctx.strokeStyle = th.accent;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(tx(hoverX), top);
      ctx.lineTo(tx(hoverX), bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (Number.isFinite(v)) {
        ctx.fillStyle = th.accent;
        ctx.beginPath();
        ctx.arc(tx(hoverX), ty(v), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = th.fg;
        ctx.textAlign = 'right';
        ctx.fillText(`${c.probe} = ${eng(v, c.unit)} @ ${eng(hoverX)}`, x1 - 6, top + 28 + k * 13);
      }
    }
  });
}

function interpLinArr(xs: number[], ys: number[], x: number): number {
  for (let k = 1; k < xs.length; k++) {
    if ((x >= xs[k - 1] && x <= xs[k]) || (x <= xs[k - 1] && x >= xs[k])) {
      const f = (x - xs[k - 1]) / (xs[k] - xs[k - 1] || 1);
      return ys[k - 1] + (ys[k] - ys[k - 1]) * f;
    }
  }
  return NaN;
}

// ─── logic analyzer ──────────────────────────────────────────────────────────

export const logicRow = 34;
export const logicHeight = (model: LogicModel): number => model.signals.length * logicRow + 30;

export function drawLogic(canvas: HTMLCanvasElement, model: LogicModel, opts: { cursorT?: number; hoverX?: number | null; maxRows?: number } = {}): { hoverT?: number } {
  const rows = model.signals.slice(0, opts.maxRows ?? model.signals.length);
  const { ctx, W, th } = begin(canvas, rows.length * logicRow + 30);
  const nameW = Math.min(150, Math.max(60, ...rows.map(s => s.name.length * 6.8 + 24)));
  const x0 = nameW;
  const x1 = W - RIGHT;
  const tEnd = model.tEnd;
  const tx = (t: number) => x0 + ((x1 - x0) * Math.min(t, tEnd)) / tEnd;
  const hoverT = opts.hoverX !== undefined && opts.hoverX !== null && opts.hoverX >= x0 && opts.hoverX <= x1 ? ((opts.hoverX - x0) / (x1 - x0)) * tEnd : undefined;
  const cur = hoverT ?? opts.cursorT;
  rows.forEach((s, row) => {
    const top = row * logicRow + 6;
    const hiY = top + 6;
    const loY = top + logicRow - 10;
    const midY = (hiY + loY) / 2;
    ctx.fillStyle = s.verdict === 'fail' ? th.fail : th.fg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${th.font}`;
    ctx.fillText(`${s.verdict === 'pass' ? '✓ ' : s.verdict === 'fail' ? '✗ ' : ''}${s.name}`, 6, midY);
    ctx.font = th.font;
    ctx.strokeStyle = th.grid;
    ctx.beginPath();
    ctx.moveTo(x0, loY + 4);
    ctx.lineTo(x1, loY + 4);
    ctx.stroke();
    // markers (windows / points); window labels alternate start/end so they never overlap
    let win = 0;
    for (const m of s.markers) {
      const col = m.verdict === 'pass' ? th.pass : th.fail;
      if (m.to !== undefined) {
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(tx(m.t), top, tx(m.to) - tx(m.t), logicRow - 6);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.textBaseline = 'alphabetic';
        if (win % 2 === 0) {
          ctx.textAlign = 'left';
          ctx.fillText(m.label, tx(m.t) + 4, top + 8);
        } else {
          ctx.textAlign = 'right';
          ctx.fillText(m.label, tx(m.to) - 14, top + 8);
        }
        win++;
      } else {
        ctx.strokeStyle = col;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(tx(m.t), top);
        ctx.lineTo(tx(m.t), loY + 4);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(m.label, tx(m.t) + 3, top + 8);
      }
    }
    // waveform
    const ch = s.changes;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    for (let k = 0; k < ch.length; k++) {
      const [ta, lv] = ch[k];
      const tb = k + 1 < ch.length ? ch[k + 1][0] : tEnd;
      const xa = tx(ta);
      const xb = tx(tb);
      if (lv === 1 || lv === 0) {
        const y = lv === 1 ? hiY : loY;
        ctx.strokeStyle = lv === 1 ? th.logic1 : th.logic0;
        ctx.beginPath();
        ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
        if (k > 0 && (ch[k - 1][1] === 0 || ch[k - 1][1] === 1)) {
          ctx.beginPath();
          ctx.moveTo(xa, ch[k - 1][1] === 1 ? hiY : loY);
          ctx.lineTo(xa, y);
          ctx.stroke();
        }
      } else if (lv === 'X') {
        ctx.fillStyle = th.logicX;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(xa, hiY, Math.max(1.5, xb - xa), loY - hiY);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = th.logicX;
        ctx.beginPath();
        ctx.rect(xa, hiY, Math.max(1.5, xb - xa), loY - hiY);
        ctx.stroke();
      } else {
        ctx.strokeStyle = th.logicZ;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xa, midY);
        ctx.lineTo(xb, midY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (cur !== undefined) {
      const lv = logicAt(ch, cur);
      ctx.fillStyle = th.fg;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(lv), x1 - 4, midY);
    }
  });
  if (cur !== undefined) {
    ctx.strokeStyle = th.accent;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(tx(cur), 4);
    ctx.lineTo(tx(cur), rows.length * logicRow + 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = th.dim;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const v of ticks(0, tEnd, 6)) ctx.fillText(eng(v, 's', 2), tx(v), rows.length * logicRow + 22);
  return { hoverT };
}
