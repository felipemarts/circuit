import { drawChart, type WaveformData } from './chartRenderer';

interface ScopeStats {
  max: number;
  min: number;
  range: number;
  freq: number;
  rms: number;
}

function calcStats(values: number[], timePoints: number[]): ScopeStats {
  if (values.length === 0) {
    return { max: 0, min: 0, range: 0, freq: 0, rms: 0 };
  }

  let max = -Infinity;
  let min = Infinity;
  let sumSq = 0;

  for (const v of values) {
    if (v > max) max = v;
    if (v < min) min = v;
    sumSq += v * v;
  }

  const rms = Math.sqrt(sumSq / values.length);
  const range = max - min;

  // Frequency estimate via mean-crossings (rising edges)
  const mean = (max + min) / 2;
  let crossings = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] < mean && values[i] >= mean) crossings++;
  }
  const duration = timePoints[timePoints.length - 1] - timePoints[0];
  const freq = duration > 0 && crossings > 0 ? crossings / duration : 0;

  return { max, min, range, freq, rms };
}

function formatScopeValue(v: number, unit: string): string {
  const abs = Math.abs(v);
  if (abs === 0) return `0 ${unit}`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)} M${unit}`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)} k${unit}`;
  if (abs >= 1) return `${v.toFixed(2)} ${unit}`;
  if (abs >= 1e-3) return `${(v * 1e3).toFixed(2)} m${unit}`;
  if (abs >= 1e-6) return `${(v * 1e6).toFixed(2)} µ${unit}`;
  return `${(v * 1e9).toFixed(2)} n${unit}`;
}

function formatFreq(hz: number): string {
  if (hz === 0) return '—';
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  if (hz >= 1) return `${hz.toFixed(1)} Hz`;
  return `${(hz * 1e3).toFixed(2)} mHz`;
}

export function showScopeOverlay(
  waveforms: WaveformData[],
  unit: string = 'V',
): void {
  const overlay = document.getElementById('scope-overlay') as HTMLElement;
  const canvas = document.getElementById('scope-canvas') as HTMLCanvasElement;
  if (!overlay || !canvas || waveforms.length === 0) return;

  overlay.hidden = false;

  // Resize canvas to match its container (CSS pixels)
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width);
  canvas.height = Math.floor(rect.height);

  const ctx = canvas.getContext('2d')!;
  drawChart(ctx, canvas.width, canvas.height, waveforms);

  // Stats computed from the first waveform (primary probe)
  const primary = waveforms[0];
  const stats = calcStats(primary.values, primary.timePoints);

  const setText = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('scope-max', formatScopeValue(stats.max, unit));
  setText('scope-min', formatScopeValue(stats.min, unit));
  setText('scope-range', formatScopeValue(stats.range, unit));
  setText('scope-freq', formatFreq(stats.freq));
  setText('scope-rms', formatScopeValue(stats.rms, unit));
}

export function hideScopeOverlay(): void {
  const overlay = document.getElementById('scope-overlay') as HTMLElement;
  if (overlay) overlay.hidden = true;
}

export function isScopeVisible(): boolean {
  const overlay = document.getElementById('scope-overlay') as HTMLElement;
  return overlay ? !overlay.hidden : false;
}

export function redrawScopeIfVisible(waveforms: WaveformData[]): void {
  if (isScopeVisible()) showScopeOverlay(waveforms);
}
