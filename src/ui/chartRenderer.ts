export interface WaveformData {
  label: string;
  color: string;
  values: number[];
  timePoints: number[];
}

const PADDING = { top: 18, right: 18, bottom: 34, left: 62 };

const FONT_TICK = "500 10px 'JetBrains Mono', 'SF Mono', ui-monospace, monospace";
const FONT_LEGEND = "600 11px 'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface ChartTheme {
  bg: string; grid: string; gridStrong: string; axis: string; tick: string; legend: string; legendBg: string;
}

const DARK: ChartTheme = {
  bg: '#0a1020', grid: 'rgba(148,163,184,0.09)', gridStrong: 'rgba(148,163,184,0.18)', axis: 'rgba(148,163,184,0.3)',
  tick: '#6b7a93', legend: '#d5dce8', legendBg: 'rgba(10,16,32,0.85)',
};
const LIGHT: ChartTheme = {
  bg: '#ffffff', grid: 'rgba(15,23,42,0.07)', gridStrong: 'rgba(15,23,42,0.14)', axis: 'rgba(15,23,42,0.3)',
  tick: '#64748b', legend: '#1e293b', legendBg: 'rgba(255,255,255,0.88)',
};

function theme(): ChartTheme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT : DARK;
}

/** Draw waveforms. `width`/`height` are CSS pixels; apply the DPR transform before calling. */
export function drawChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveforms: WaveformData[],
): void {
  const t = theme();
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, width, height);

  if (waveforms.length === 0 || waveforms[0].timePoints.length === 0) return;

  const plotW = Math.max(1, width - PADDING.left - PADDING.right);
  const plotH = Math.max(1, height - PADDING.top - PADDING.bottom);

  const timePoints = waveforms[0].timePoints;
  const tMin = timePoints[0];
  const tMax = timePoints[timePoints.length - 1];

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const w of waveforms) {
    for (const v of w.values) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;

  const yRange = yMax - yMin || Math.abs(yMax) || 1;
  yMin -= yRange * 0.1;
  yMax += yRange * 0.1;
  const tRange = tMax - tMin || 1;

  const mapX = (tt: number) => PADDING.left + ((tt - tMin) / tRange) * plotW;
  const mapY = (v: number) => PADDING.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Grid
  ctx.lineWidth = 1;
  ctx.font = FONT_TICK;
  ctx.fillStyle = t.tick;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (i / yTicks) * (yMax - yMin);
    const y = Math.round(mapY(v)) + 0.5;
    ctx.strokeStyle = t.grid;
    ctx.beginPath(); ctx.moveTo(PADDING.left, y); ctx.lineTo(width - PADDING.right, y); ctx.stroke();
    ctx.fillText(formatYLabel(v), PADDING.left - 8, y);
  }
  // Zero line
  if (yMin < 0 && yMax > 0) {
    const y0 = Math.round(mapY(0)) + 0.5;
    ctx.strokeStyle = t.gridStrong;
    ctx.beginPath(); ctx.moveTo(PADDING.left, y0); ctx.lineTo(width - PADDING.right, y0); ctx.stroke();
  }
  const xTicks = Math.max(2, Math.min(8, Math.floor(plotW / 90)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= xTicks; i++) {
    const tt = tMin + (i / xTicks) * tRange;
    const x = Math.round(mapX(tt)) + 0.5;
    ctx.strokeStyle = t.grid;
    ctx.beginPath(); ctx.moveTo(x, PADDING.top); ctx.lineTo(x, height - PADDING.bottom); ctx.stroke();
    ctx.fillStyle = t.tick;
    ctx.fillText(formatTimeLabel(tt), x, height - PADDING.bottom + 7);
  }

  // Axes
  ctx.strokeStyle = t.axis;
  ctx.beginPath();
  ctx.moveTo(PADDING.left + 0.5, PADDING.top); ctx.lineTo(PADDING.left + 0.5, height - PADDING.bottom + 0.5);
  ctx.lineTo(width - PADDING.right, height - PADDING.bottom + 0.5);
  ctx.stroke();

  // Waveforms: glow pass + crisp pass, decimated to the pixel column
  ctx.save();
  ctx.beginPath();
  ctx.rect(PADDING.left, PADDING.top, plotW, plotH);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const w of waveforms) {
    const n = Math.min(w.values.length, w.timePoints.length);
    if (n === 0) continue;
    const stride = Math.max(1, Math.floor(n / (plotW * 2)));
    const trace = () => {
      ctx.beginPath();
      for (let i = 0; i < n; i += stride) {
        const x = mapX(w.timePoints[i]);
        const y = mapY(w.values[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if ((n - 1) % stride !== 0) ctx.lineTo(mapX(w.timePoints[n - 1]), mapY(w.values[n - 1]));
    };
    ctx.strokeStyle = w.color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 5;
    trace(); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.6;
    trace(); ctx.stroke();
  }
  ctx.restore();

  // Legend chips (top-left of the plot)
  ctx.font = FONT_LEGEND;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = PADDING.left + 10;
  const ly = PADDING.top + 12;
  for (const w of waveforms) {
    const tw = ctx.measureText(w.label).width;
    const bw = tw + 26;
    ctx.fillStyle = t.legendBg;
    roundRect(ctx, lx, ly - 9, bw, 18, 6);
    ctx.fill();
    ctx.fillStyle = w.color;
    ctx.beginPath(); ctx.arc(lx + 10, ly, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = t.legend;
    ctx.fillText(w.label, lx + 19, ly + 0.5);
    lx += bw + 6;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function formatYLabel(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-12) return '0';
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 1e-3) return (v * 1e3).toFixed(1) + 'm';
  if (abs >= 1e-6) return (v * 1e6).toFixed(1) + 'µ';
  return (v * 1e9).toFixed(1) + 'n';
}

function formatTimeLabel(t: number): string {
  const abs = Math.abs(t);
  if (abs === 0) return '0';
  if (abs >= 1) return t.toFixed(2) + 's';
  if (abs >= 1e-3) return (t * 1e3).toFixed(2) + 'ms';
  if (abs >= 1e-6) return (t * 1e6).toFixed(1) + 'µs';
  return (t * 1e9).toFixed(1) + 'ns';
}
