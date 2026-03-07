export interface WaveformData {
  label: string;
  color: string;
  values: number[];
  timePoints: number[];
}

const PADDING = { top: 20, right: 20, bottom: 40, left: 60 };

export function drawChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveforms: WaveformData[],
): void {
  // Background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  if (waveforms.length === 0) return;

  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  // Compute ranges
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

  // Add 10% padding
  const yRange = yMax - yMin || 1;
  yMin -= yRange * 0.1;
  yMax += yRange * 0.1;

  const tRange = tMax - tMin || 1;

  function mapX(t: number): number {
    return PADDING.left + ((t - tMin) / tRange) * plotW;
  }
  function mapY(v: number): number {
    return PADDING.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  }

  // Grid lines
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;

  // Y grid (6 ticks)
  const yTicks = 6;
  ctx.font = '10px "SF Mono", "Fira Code", monospace';
  ctx.fillStyle = '#475569';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (i / yTicks) * (yMax - yMin);
    const y = mapY(v);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(width - PADDING.right, y);
    ctx.stroke();
    ctx.fillText(formatYLabel(v), PADDING.left - 6, y);
  }

  // X grid (8 ticks)
  const xTicks = 8;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i <= xTicks; i++) {
    const t = tMin + (i / xTicks) * tRange;
    const x = mapX(t);
    ctx.beginPath();
    ctx.moveTo(x, PADDING.top);
    ctx.lineTo(x, height - PADDING.bottom);
    ctx.stroke();
    ctx.fillText(formatTimeLabel(t), x, height - PADDING.bottom + 6);
  }

  // Plot area border
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(PADDING.left, PADDING.top, plotW, plotH);

  // Draw waveforms
  for (const w of waveforms) {
    ctx.strokeStyle = w.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < w.values.length; i++) {
      const x = mapX(w.timePoints[i]);
      const y = mapY(w.values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Legend
  const legendX = PADDING.left + 10;
  let legendY = PADDING.top + 8;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';

  for (const w of waveforms) {
    // Color line
    ctx.strokeStyle = w.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 16, legendY);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(w.label, legendX + 22, legendY);
    legendY += 16;
  }
}

function formatYLabel(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return '0';
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
