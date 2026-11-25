/**
 * Human formatting for the viewer: engineering notation with proper unit
 * symbols (330 Ω, 10 µF, 4.7 kΩ, 1 kHz), component value labels and
 * waveform summaries (PULSE 0→5 V 1 kHz). Browser-safe, no dependencies.
 */
import type { CircuitComponent } from '../doc/types';
import type { ParamValue } from '../schema/types';

const PREFIXES: [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
];

/** 0.0047 → "4.7 m"; 330 → "330"; 1e6 → "1 M". Three significant digits, trailing zeros trimmed. */
/** Units that never take an SI prefix (3 nano-dB is not a thing). */
const NO_PREFIX = new Set(['dB', '°', '%', 'x']);

export function eng(value: number, unit = '', digits = 3): string {
  if (!Number.isFinite(value)) return `${value}`;
  if (value === 0) return unit ? `0 ${unit}` : '0';
  if (NO_PREFIX.has(unit)) {
    const abs = Math.abs(value);
    const text = abs < 0.005 ? '0' : abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
    return `${text}${unit === '°' || unit === '%' ? '' : ' '}${unit}`;
  }
  const abs = Math.abs(value);
  let scale = 1;
  let prefix = '';
  for (const [s, p] of PREFIXES) {
    if (abs >= s * 0.9995) {
      scale = s;
      prefix = p;
      break;
    }
  }
  // Below a femto-unit the value is numerical noise (an off transistor's 1e-29 A): read it as zero.
  if (abs < 1e-15 * 0.9995) return unit ? `0 ${unit}` : '0';
  let scaled = value / scale;
  let text = Number(scaled.toPrecision(digits)).toString();
  // 999.6 → "1000": bump the prefix instead.
  if (Math.abs(Number(text)) >= 1000) {
    const idx = PREFIXES.findIndex(([s]) => s === scale);
    if (idx > 0) {
      scale = PREFIXES[idx - 1][0];
      prefix = PREFIXES[idx - 1][1];
      scaled = value / scale;
      text = Number(scaled.toPrecision(digits)).toString();
    }
  }
  const sep = unit || prefix ? ' ' : '';
  return `${text}${sep}${prefix}${unit}`;
}

/** Seconds with a sensible unit (1.5 ms, 20 µs). */
export const secs = (t: number, digits = 3): string => eng(t, 's', digits);

/** Percentage with one decimal when small (82.9 %). */
export function pct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  const v = ratio * 100;
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} %`;
}

const num = (v: ParamValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const obj = (v: ParamValue | undefined): Record<string, ParamValue> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ParamValue>) : undefined;

/** The unit of a probe quantity ('i' → A, 'v' → V, 'p' → W, 'vce' → V, 'ic' → A, nets → V). */
export function probeUnit(probe: string): string {
  const m = probe.match(/\.([a-z][a-z0-9]*)$/);
  if (!m) return 'V';
  const q = m[1];
  if (q === 'p') return 'W';
  if (q === 'i' || /^i[a-z]*$/.test(q)) return 'A';
  if (q === 'v' || /^v[a-z]*$/.test(q)) return 'V';
  // IC / primitive pins ('U1.1Y', 'G1.y') are voltages; uppercase pins never reach here.
  return 'V';
}

/** One-line waveform description of a source ("PULSE 0→5 V 1 kHz", "SIN 1 V 1 kHz", "AC 1 V"). */
export function waveformLabel(params: Record<string, ParamValue>, unit: 'V' | 'A'): string | undefined {
  const sin = obj(params.sin);
  if (sin) {
    const amp = num(sin.amplitude) ?? 0;
    const f = num(sin.freq) ?? 0;
    const off = num(sin.offset) ?? 0;
    return `SIN ${eng(amp, unit)} ${eng(f, 'Hz')}${off ? ` +${eng(off, unit)}` : ''}`;
  }
  const pulse = obj(params.pulse);
  if (pulse) {
    const v1 = num(pulse.v1) ?? 0;
    const v2 = num(pulse.v2) ?? 0;
    const per = num(pulse.per);
    return `PULSE ${eng(v1)}→${eng(v2, unit)}${per ? ` ${eng(1 / per, 'Hz')}` : ''}`;
  }
  const pwm = obj(params.pwm);
  if (pwm) {
    const hi = num(pwm.high) ?? 0;
    const f = num(pwm.freq) ?? 0;
    const duty = num(pwm.duty) ?? 0.5;
    return `PWM ${eng(hi, unit)} ${eng(f, 'Hz')} ${Math.round(duty * 100)} %`;
  }
  const pwl = obj(params.pwl);
  if (pwl) {
    const pts = Array.isArray(pwl.points) ? pwl.points.length : 0;
    return `PWL ${pts} pts`;
  }
  const ac = obj(params.ac);
  if (ac) return `AC ${eng(num(ac.mag) ?? 1, unit)}`;
  return undefined;
}

/** Secondary label of a component: its value (330 Ω), part id (2N3904) or waveform. */
export function valueLabel(c: CircuitComponent): string | undefined {
  const p = c.params;
  switch (c.type) {
    case 'Resistor':
      return eng(num(p.r) ?? 0, 'Ω');
    case 'Capacitor':
      return eng(num(p.c) ?? 0, 'F');
    case 'Inductor':
      return eng(num(p.l) ?? 0, 'H');
    case 'VoltageSource': {
      const wave = waveformLabel(p, 'V');
      const dc = num(p.v) ?? 0;
      if (wave && dc !== 0 && !obj(p.pulse) && !obj(p.pwm)) return `${eng(dc, 'V')} · ${wave}`;
      return wave ?? eng(dc, 'V');
    }
    case 'CurrentSource': {
      const wave = waveformLabel(p, 'A');
      const dc = num(p.i) ?? 0;
      if (wave && dc !== 0 && !obj(p.pulse) && !obj(p.pwm)) return `${eng(dc, 'A')} · ${wave}`;
      return wave ?? eng(dc, 'A');
    }
    case 'Switch':
      return p.closed ? 'closed' : 'open';
    case 'Button':
      return p.pressed ? 'pressed' : 'released';
    case 'Diode':
    case 'LED':
    case 'NPN':
    case 'PNP':
    case 'NMOS':
    case 'PMOS': {
      if (typeof p.part === 'string') return p.part;
      if (typeof p.model === 'string') return p.model;
      if (c.type === 'Diode' && typeof p.BV === 'number' && p.BV < 100) return `Zener ${eng(p.BV, 'V')}`;
      return undefined;
    }
    case 'Clock': {
      const f = num(p.freq);
      return f ? eng(f, 'Hz') : undefined;
    }
    case 'Const':
    case 'Pull':
      return p.value !== undefined ? `= ${p.value}` : undefined;
    default:
      return undefined;
  }
}

/** Whether a diode is a Zener (a low breakdown voltage in the model). */
export function isZener(c: CircuitComponent): boolean {
  if (c.type !== 'Diode') return false;
  const bv = num(c.params.BV);
  if (bv !== undefined && bv > 0 && bv < 200) return true;
  const part = typeof c.params.part === 'string' ? c.params.part : '';
  return /^(BZX|1N47|1N52|ZEN)/i.test(part);
}

/** Expected-value text of a check ("in [5 mA, 15 mA]", "< 300 mV", "≈ 1.4 mA ± 0.1 mA"). */
export function checkLabel(check: { op: string; [k: string]: unknown }, unit: string): string {
  const n = (k: string): number => check[k] as number;
  const scalar = (ch: { op: string; [k: string]: unknown }, u: string): string => {
    switch (ch.op) {
      case 'within':
        return `in [${eng(ch.min as number, u)}, ${eng(ch.max as number, u)}]`;
      case 'closeTo':
        return `≈ ${eng(ch.value as number, u)} ± ${eng(ch.tol as number, u)}`;
      case 'above':
        return `> ${eng(ch.value as number, u)}`;
      case 'below':
        return `< ${eng(ch.value as number, u)}`;
      default:
        return ch.op;
    }
  };
  switch (check.op) {
    case 'within':
    case 'closeTo':
    case 'above':
    case 'below':
      return scalar(check, unit);
    case 'at':
      return `at x = ${eng(n('x'))}: ${scalar(check.check as { op: string }, unit)}`;
    case 'slopeAt':
      return `slope at x = ${eng(n('x'))}: ${scalar(check.check as { op: string }, `${unit}/x`)}`;
    case 'monotonic':
      return `monotonic ${check.direction}`;
    case 'crosses':
      return `crosses ${eng(n('level'), unit)}${check.min !== undefined ? ` in [${eng(n('min'))}, ${eng(n('max'))}]` : ''}`;
    case 'gainAt':
      return `gain @ ${eng(n('f'), 'Hz')} ${scalar(check.check as { op: string }, 'dB')}`;
    case 'phaseAt':
      return `phase @ ${eng(n('f'), 'Hz')} ${scalar(check.check as { op: string }, '°')}`;
    case 'bandwidth3dB':
      return `−3 dB bandwidth ${scalar(check.check as { op: string }, 'Hz')}`;
    case 'unityGainFrequency':
      return `unity-gain f ${scalar(check.check as { op: string }, 'Hz')}`;
    case 'phaseMargin':
      return `phase margin ${scalar(check.check as { op: string }, '°')}`;
    case 'settleWithin':
      return `settles to ${eng(n('target'), unit)} ± ${Math.round(n('tol') * 100)} % by ${secs(n('by'))}`;
    case 'neverExceed':
      return `never exceeds ${eng(n('value'), unit)}`;
    case 'stayAbove':
      return `stays above ${eng(n('value'), unit)}${check.from !== undefined ? ` from ${secs(n('from'))}` : ''}`;
    case 'stayBelow':
      return `stays below ${eng(n('value'), unit)}${check.from !== undefined ? ` from ${secs(n('from'))}` : ''}`;
    case 'rippleBelow':
      return `ripple < ${eng(n('amplitude'), unit)}${check.from !== undefined ? ` from ${secs(n('from'))}` : ''}`;
    case 'finalCloseTo':
      return `ends ≈ ${eng(n('value'), unit)} ± ${eng(n('tol'), unit)}`;
    case 'logicAt':
      return `= ${check.value} at ${secs(n('t'))}`;
    case 'logicEdges':
      return `${check.edge} edges${check.count !== undefined ? ` = ${check.count}` : ''}${check.min !== undefined ? ` ≥ ${check.min}` : ''}${check.max !== undefined ? ` ≤ ${check.max}` : ''}`;
    case 'logicFrequency':
      return `frequency ≈ ${eng(n('value'), 'Hz')} ± ${Math.round(n('tol') * 100)} %`;
    case 'logicDutyCycle':
      return `duty ≈ ${Math.round(n('value') * 100)} % ± ${Math.round(n('tol') * 100)} %`;
    case 'logicStable':
      return `stable${check.value !== undefined ? ` = ${check.value}` : ''} in [${secs(n('from'))}, ${secs(n('to'))}]`;
    default:
      return check.op;
  }
}

/** Measured value text for an assertion result (uses the probe unit; dB/Hz/° for AC checks). */
export function measuredUnit(check: { op: string }, probe: string): string {
  switch (check.op) {
    case 'gainAt':
      return 'dB';
    case 'phaseAt':
    case 'phaseMargin':
      return '°';
    case 'bandwidth3dB':
    case 'unityGainFrequency':
    case 'logicFrequency':
      return 'Hz';
    case 'crosses':
      return '';
    case 'logicEdges':
      return '';
    case 'logicDutyCycle':
      return '';
    case 'settleWithin':
      return 's';
    default:
      return probeUnit(probe);
  }
}
