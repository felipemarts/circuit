import { describe, it, expect } from 'vitest';
import {
  Circuit,
  VoltageSource,
  CurrentSource,
  Resistor,
  Capacitor,
  Inductor,
  Diode,
  LED,
  Switch,
  Button,
  waveformValue,
  describeComponent,
  buildComponent,
  Part,
  Nand,
  DFF,
  Clock,
  Stimulus,
  Const,
  Counter,
  NPN,
  PNP,
  NMOS,
  PMOS,
} from '../../src/forge';
import type { WaveformSpec } from '../../src/forge';

/** Drive a 1 kΩ resistor with the source and return its voltage waveform. */
function driveResistor(src: VoltageSource, tstop: number, maxStep: number) {
  const circuit = new Circuit();
  const r1 = new Resistor(1000);
  src.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(circuit.ground);
  src.pin('-').connect(circuit.ground);
  const res = circuit.analyze('transient', { timeStep: maxStep / 10, maxStep, duration: tstop, adaptive: true }, [
    { label: 'v', color: '', component: r1, type: 'voltage' },
  ]);
  return { t: res.timePoints, v: res.probes[0].values };
}

describe('independent sources — API', () => {
  it('new VoltageSource(5) and unit strings keep working', () => {
    expect(new VoltageSource(5).declaredVoltage).toBe(5);
    expect(new VoltageSource('3.3V').declaredVoltage).toBe(3.3);
    expect(new CurrentSource('1m').currentValue).toBe(1e-3);
  });

  it('waveform options are normalized to plain JSON numbers with defaults materialized', () => {
    const v = new VoltageSource({ pulse: { v1: 0, v2: '5', tr: '1u', pw: '1m', per: '2m' } });
    expect(v.waveform).toEqual({ pulse: { v1: 0, v2: 5, td: 0, tr: 1e-6, tf: 0, pw: 1e-3, per: 2e-3 } });
    expect(v.declaredVoltage).toBe(0); // dc defaults to the value at t = 0
    const s = new VoltageSource({ dc: 1, sin: { amplitude: 1, freq: '1k' }, ac: { mag: 2, phase: 90 } });
    expect(s.declaredVoltage).toBe(1);
    expect(s.acStimulus).toEqual({ mag: 2, phase: 90 });
    expect(new VoltageSource({ pwm: { high: 5, freq: '10k', duty: '25%' } }).waveform).toEqual({
      pwm: { low: 0, high: 5, freq: 1e4, duty: 0.25, rise: 0, fall: 0, delay: 0 },
    });
  });

  it('rejects ambiguous or invalid waveforms with actionable messages', () => {
    expect(() => new VoltageSource({ sin: { amplitude: 1, freq: 1 }, pulse: { v1: 0, v2: 1, pw: 1 } })).toThrow(/at most one waveform/);
    expect(() => new VoltageSource({ pulse: { v1: 0, v2: 1, pw: '2m', per: '1m' } })).toThrow(/exceeds the period/);
    expect(() => new VoltageSource({ pwl: { points: [[0, 0], [0, 1]] } })).toThrow(/strictly increasing/);
    expect(() => new VoltageSource({ pwm: { high: 5, freq: '1k', duty: 1 } })).toThrow(/strictly between 0 and 1/);
    expect(() => new VoltageSource({ dc: 1, foo: 2 } as never)).toThrow(/unknown option 'foo'/);
  });

  it('describe → build round-trips every built-in component (serialization contract)', () => {
    const comps = [
      new Resistor('4.7k'),
      new Capacitor('10u'),
      new Inductor('1m'),
      new VoltageSource(5),
      new VoltageSource({ dc: 2.5, ac: 1, sin: { offset: 2.5, amplitude: 1, freq: '1k', delay: '1m', damping: 10, phase: 30 } }),
      new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1u', tr: '1u', tf: '2u', pw: '1m', per: '3m' } }),
      new VoltageSource({ pwl: { points: [[0, 0], ['1m', 5], ['2m', 1]], repeat: true } }),
      new CurrentSource({ pwm: { low: 0, high: '1m', freq: '10k', duty: 0.3, rise: '10n', fall: '10n' } }),
      new Diode({ Is: 1e-12, n: 1.8 }),
      new LED(),
      new Diode({ Is: '2.5n', n: 1.75, Rs: 0.5, Cjo: '4p', Vj: 0.7, M: 0.4, Tt: '20n', BV: 100, IBV: '100u' }),
      new LED({ Rs: 2.75 }),
      Diode.fromModel('.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)'),
      new NPN({ bf: 150, vaf: 80, ikf: '50m', rb: 10, cje: '5p', tf: '400p' }),
      new PNP({ bf: 90 }),
      new NMOS({ vto: 1.8, kp: 0.14, lambda: 0.01, rd: 0.35, cgso: '16p' }),
      new PMOS({ vto: -2, kp: '50m', bulkPin: true, bodyDiode: { Is: 1e-12, n: 1.2, Rs: 0.1 } }),
      Part('2N3904'),
      Part('IRLZ44N'),
      Part('1N4733A'),
      Part('LED-RED-5MM'),
      new Switch(true),
      new Button(false),
      // Mixed-signal devices: real ICs (catalog id as type) and generic logic primitives.
      Part('74HC00'),
      Part('74HC14', { corner: 'worst' }),
      Part('74HC595', { clamp: false }),
      Part('CD4017'),
      Part('NE555'),
      new Nand({ inputs: 3, delay: '5n', family: 'HCT' }),
      new DFF({ delay: { rise: '2n', fall: '3n' }, setup: '1n', reset: true, vcc: 3.3 }),
      new Clock({ freq: '1M', duty: 0.25 }),
      new Stimulus({ pattern: '0110', step: '1u' }),
      new Const(1),
      new Counter({ bits: 3, enable: true }),
    ];
    for (const c of comps) {
      const info = describeComponent(c);
      // Plain JSON: survives a JSON round trip unchanged.
      expect(JSON.parse(JSON.stringify(info.params))).toEqual(info.params);
      const rebuilt = buildComponent(info.type, JSON.parse(JSON.stringify(info.params)));
      expect(describeComponent(rebuilt)).toEqual(info);
    }
  });

  it('the legacy transient sine (acAmplitude/frequency) is described as a sin waveform', () => {
    const v = new VoltageSource(1);
    v.acAmplitude = 0.5;
    v.frequency = 50;
    const info = describeComponent(v);
    expect(info.params).toEqual({ v: 1, sin: { offset: 1, amplitude: 0.5, freq: 50, delay: 0, damping: 0, phase: 0 } });
    expect(describeComponent(buildComponent(info.type, info.params))).toEqual(info);
  });
});

describe('independent sources — waveforms in transient', () => {
  it('PWL: samples equal the linear interpolation of the corners (1e-12), corners are landed on', () => {
    const points: [number, number][] = [[0, 0], [1e-3, 2], [1.5e-3, 2], [4e-3, -1]];
    const { t, v } = driveResistor(new VoltageSource({ pwl: { points } }), 5e-3, 2e-4);
    for (const [tc] of points) expect(t).toContain(tc);
    const interp = (x: number) => {
      if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
      for (let i = 1; i < points.length; i++) {
        if (x <= points[i][0]) {
          const [ta, va] = points[i - 1];
          const [tb, vb] = points[i];
          return va + ((vb - va) * (x - ta)) / (tb - ta);
        }
      }
      return points[0][1];
    };
    for (let i = 0; i < t.length; i++) expect(Math.abs(v[i] - interp(t[i]))).toBeLessThan(1e-12);
  });

  it('PWL repeat: the pattern repeats with period last − first', () => {
    const w: WaveformSpec = { pwl: { points: [[0, 0], [1, 1], [2, 0]], repeat: true } };
    expect(waveformValue(w, 0.5)).toBeCloseTo(0.5, 12);
    expect(waveformValue(w, 2.5)).toBeCloseTo(0.5, 12);
    expect(waveformValue(w, 5)).toBeCloseTo(1, 12);
  });

  it('SIN with delay, damping and phase matches the closed form (1e-9)', () => {
    const sin = { offset: 1, amplitude: 2, freq: 1000, delay: 0.5e-3, damping: 200, phase: 30 };
    const { t, v } = driveResistor(new VoltageSource({ sin }), 5e-3, 1e-4);
    const ph = (30 * Math.PI) / 180;
    for (let i = 0; i < t.length; i++) {
      const tt = t[i];
      const exact =
        tt <= sin.delay
          ? 1 + 2 * Math.sin(ph)
          : 1 + 2 * Math.exp(-200 * (tt - sin.delay)) * Math.sin(2 * Math.PI * 1000 * (tt - sin.delay) + ph);
      expect(Math.abs(v[i] - exact)).toBeLessThan(1e-9);
    }
    expect(t).toContain(sin.delay); // the delay is a breakpoint
    // ≥ 25 points per period even with a coarse maxStep.
    expect(t.length).toBeGreaterThan(5 * 25);
  });

  it('PWM: the duty cycle measured from the simulated waveform matches the spec (0.1 %)', () => {
    const duty = 0.3;
    const { t, v } = driveResistor(
      new VoltageSource({ pwm: { low: 0, high: 5, freq: '1k', duty, rise: '20u', fall: '20u' } }),
      10e-3,
      50e-6,
    );
    // Time above the 50 % level (2.5 V), integrated over the piecewise-linear samples.
    let above = 0;
    for (let i = 1; i < t.length; i++) {
      const a = v[i - 1] - 2.5;
      const b = v[i] - 2.5;
      const dt = t[i] - t[i - 1];
      if (a >= 0 && b >= 0) above += dt;
      else if (a >= 0 || b >= 0) above += (dt * Math.max(a, b)) / Math.abs(b - a);
    }
    expect(Math.abs(above / 10e-3 - duty)).toBeLessThan(1e-3);
  });

  it('PULSE value is left-continuous at ideal (zero-time) edges', () => {
    const w: WaveformSpec = { pulse: { v1: 0, v2: 5, td: 1, tr: 0, tf: 0, pw: 1, per: 3 } };
    expect(waveformValue(w, 1)).toBe(0);
    expect(waveformValue(w, 1.5)).toBe(5);
    expect(waveformValue(w, 2)).toBe(5);
    expect(waveformValue(w, 2.5)).toBe(0);
    expect(waveformValue(w, 4)).toBe(0);
    expect(waveformValue(w, 4.5)).toBe(5);
  });
});
