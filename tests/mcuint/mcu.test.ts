import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  runLadderAsync,
  ArduinoUno,
  Mcu,
  Part,
  VoltageSource,
  Resistor,
  Capacitor,
  LED,
  AsyncAnalysisError,
  toCircuitDoc,
  isCircuitDocError,
  MCU_ELECTRICAL,
  type RunRecord,
} from '../../src/forge';
import { load } from '../share/helpers';
import { fw, powerMcu, wavesAsync, at } from './helpers';

const BLINK = `import { pinMode, digitalWrite, delay, OUTPUT, HIGH, LOW } from 'circuitsvibe/arduino';
export async function setup() { pinMode(13, OUTPUT); }
export async function loop() {
  digitalWrite(13, HIGH);
  await delay(500);
  digitalWrite(13, LOW);
  await delay(500);
}`;

const R_HIGH_5V = MCU_ELECTRICAL.atmega328p.drive[1].rHigh; // (5 − 4.2) / 20 mA = 40 Ω

const codes = (r: RunRecord) => r.diagnostics.map(d => d.code);

describe('MCU pin electrical model (ATmega328P / Uno)', () => {
  it('derives Rout from the datasheet VOH/VOL rows', () => {
    const d = MCU_ELECTRICAL.atmega328p.drive;
    expect(d[1].rHigh).toBeCloseTo(40, 9); // VOH 4.2 V at 20 mA
    expect(d[1].rLow).toBeCloseTo(45, 9); // VOL 0.9 V at 20 mA
    expect(d[0].rHigh).toBeCloseTo(70, 9); // VOH 2.3 V at 10 mA, VCC 3 V
  });

  it('blink into a resistor: I = VCC / (R + Rout) while high, edges exactly every 500 ms', async () => {
    const desc = bench('blink-r', tb => {
      const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(BLINK) }));
      powerMcu(tb, u1);
      const r1 = tb.add('R1', new Resistor('1k'));
      u1.pin('D13').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      tb.expect.tran({ tstop: '2.2', maxStep: '10m' }).logic('U1.D13').toToggle({ count: 4, within: [0.1, 2.1] });
    });
    const w = await wavesAsync(desc, 2.2, ['R1.i'], 10e-3);
    expect(at(w.t, w.v['R1.i'], 0.25) / (5 / (1000 + R_HIGH_5V))).toBeCloseTo(1, 5);
    expect(Math.abs(at(w.t, w.v['R1.i'], 0.75))).toBeLessThan(1e-9);
    const tr = w.elab.mixed!.controller.trace('mcu:U1.D13')!;
    expect(tr.t).toEqual([0, 0.5, 1, 1.5, 2]); // firmware time = simulation time, exactly
    expect(tr.v).toEqual([1, 0, 1, 0, 1]);
  });

  it('blink into an LED (bench/mcu/uno-blink): I = (VOH − Vf) / R with VOH = VCC − Rout·I', async () => {
    const desc = await load('bench/mcu/uno-blink.bench.ts');
    const w = await wavesAsync(desc, 2.2, ['D1.i', 'D1.v', 'U1.D13'], 10e-3);
    const i = at(w.t, w.v['D1.i'], 0.25);
    const vf = at(w.t, w.v['D1.v'], 0.25);
    expect(i).toBeGreaterThan(7e-3);
    expect(i).toBeLessThan(9e-3);
    expect(i * (330 + R_HIGH_5V)).toBeCloseTo(5 - vf, 6); // (VOH − Vf)/(R + Rout)
    expect(at(w.t, w.v['U1.D13'], 0.25)).toBeCloseTo(5 - R_HIGH_5V * i, 6);
    const r = await runLadderAsync(desc);
    expect(r.exitCode).toBe(0);
    expect(r.stages.tran!.serial).toEqual([{ config: 'tstop=2.2s,dt=0.0022s,maxStep=0.01s', mcu: 'U1', lines: [[0, 'blink ready']] }]);
    const d13 = r.stages.tran!.ratings!.find(x => x.code === 'R410')!;
    expect(d13).toMatchObject({ verdict: 'pass', component: 'U1', part: 'ATmega328P', quantity: 'U1.D13.i', limit: 0.04 });
    expect(d13.value).toBeCloseTo(i, 6);
  });

  it('analogRead of a divider returns floor(Vin·1024/Vref) — also with INTERNAL 1.1 V and a sagging VCC', async () => {
    const src = `import { analogRead, analogReference, delay, Serial, A0, A1, INTERNAL } from 'circuitsvibe/arduino';
export async function setup() { Serial.begin(9600); }
export async function loop() {
  Serial.println(analogRead(A0));
  analogReference(INTERNAL);
  Serial.println(analogRead(A1));
  await delay(10);
}`;
    const make = (vcc: number) =>
      bench('adc', tb => {
        const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(src) }));
        const v = powerMcu(tb, u1, vcc);
        const ra = tb.add('RA', new Resistor('10k'));
        const rb = tb.add('RB', new Resistor('4.7k'));
        const rc = tb.add('RC', new Resistor('100k'));
        const rd = tb.add('RD', new Resistor('10k'));
        v.pin('+').connect(ra.pin('1'));
        ra.pin('2').connect(rb.pin('1'));
        rb.pin('2').connect(tb.gnd);
        u1.pin('A0').connect(ra.pin('2'));
        v.pin('+').connect(rc.pin('1'));
        rc.pin('2').connect(rd.pin('1'));
        rd.pin('2').connect(tb.gnd);
        u1.pin('A1').connect(rc.pin('2'));
        tb.expect.serial('U1', { tstop: '5m' }).toHaveLines({ min: 2 });
      });
    for (const vcc of [5, 4.6]) {
      const r = await runLadderAsync(make(vcc));
      expect(r.exitCode).toBe(0);
      const lines = r.stages.tran!.serial![0].lines.map(l => Number(l[1]));
      const a0 = (vcc * 4.7) / 14.7;
      const a1 = (vcc * 10) / 110;
      expect(lines[0]).toBe(Math.floor((a0 * 1024) / vcc)); // DEFAULT reference = the simulated VCC
      expect(lines[1]).toBe(Math.floor((a1 * 1024) / 1.1)); // INTERNAL 1.1 V
    }
  });

  it('potentiometer → analogRead → analogWrite → RC average (bench/mcu/uno-adc-pwm): within 2 %, real edges and averaged PWM agree', async () => {
    const desc = await load('bench/mcu/uno-adc-pwm.bench.ts');
    const r = await runLadderAsync(desc);
    expect(r.exitCode).toBe(0);
    const expected = (5 * 83) / 255;
    const w = await wavesAsync(desc, 0.5, ['avg'], 1e-3);
    const tail = w.t.map((t, k) => [t, w.v.avg[k]]).filter(([t]) => t >= 0.4);
    let area = 0;
    for (let k = 1; k < tail.length; k++) area += ((tail[k][1] + tail[k - 1][1]) / 2) * (tail[k][0] - tail[k - 1][0]);
    const mean = area / (tail[tail.length - 1][0] - tail[0][0]);
    expect(Math.abs(mean / expected - 1)).toBeLessThan(0.02);
    // pwm: 'average' — the pin is its duty-cycle Thevenin average: same filtered voltage, no edges.
    const src = `import { analogWrite, pinMode, delay, OUTPUT } from 'circuitsvibe/arduino';
export async function setup() { pinMode(9, OUTPUT); analogWrite(9, 83); }
export async function loop() { await delay(100); }`;
    const avg = bench('avg', tb => {
      const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(src), pwm: 'average' }));
      powerMcu(tb, u1);
      const rf = tb.add('RF', new Resistor('47k'));
      const cf = tb.add('CF', new Capacitor('1u'));
      u1.pin('D9').connect(rf.pin('1'));
      rf.pin('2').connect(cf.pin('1'));
      cf.pin('2').connect(tb.gnd);
      tb.name('avg', cf.pin('1'));
      tb.expect.tran({ tstop: '0.5', maxStep: '5m' }).probe('avg').toEndCloseTo(expected, expected * 0.02);
    });
    const ra = await runLadderAsync(avg);
    expect(ra.exitCode).toBe(0);
    expect(ra.stages.tran!.solver!.acceptedSteps).toBeLessThan(400); // no PWM edges to land on
  });

  it('INPUT_PULLUP + attachInterrupt(FALLING) counts the presses of a PULSE-driven switch (no bounce, no debounce)', async () => {
    const desc = await load('bench/mcu/uno-button-interrupt.bench.ts');
    const r = await runLadderAsync(desc);
    expect(r.exitCode).toBe(0);
    const lines = r.stages.tran!.serial![0].lines;
    expect(lines.map(l => l[1])).toEqual(['presses=1', 'presses=2', 'presses=3', 'presses=4', 'presses=5']);
    // Reported by loop() within one 5 ms pass after each press (presses at 20, 80, 140, 200, 260 ms).
    lines.forEach(([t], k) => {
      expect(t).toBeGreaterThanOrEqual(0.02 + 0.06 * k);
      expect(t).toBeLessThanOrEqual(0.02 + 0.06 * k + 0.0051);
    });
    // The FALLING edges the ISR saw are the analog threshold crossings (VIL = 1.5 V) right after each gate edge.
    const tr = (await wavesAsync(desc, 0.31, ['button'], 1e-3)).elab.mixed!.controller.trace('mcu:U1.D2')!;
    const falls = tr.t.filter((_, k) => k > 0 && tr.v[k] === 0 && tr.v[k - 1] === 1);
    expect(falls.length).toBe(5);
    falls.forEach((t, k) => expect(Math.abs(t - (0.02 + 0.06 * k))).toBeLessThan(2e-6));
  });

  it('serial assertions pass and fail with the output in the note', async () => {
    const pass = await runLadderAsync(await load('bench/mcu/uno-blink.bench.ts'));
    expect(pass.stages.tran!.assertions!.find(a => a.check.op === 'serialContains')).toMatchObject({ verdict: 'pass', measured: 0 });
    const fail = await runLadderAsync(await load('bench/broken/mcu-serial-missing.bench.ts'));
    expect(fail.exitCode).toBe(1);
    const [m, c] = fail.stages.tran!.assertions!;
    expect(m).toMatchObject({ verdict: 'fail', check: { op: 'serialMatches', pattern: '^ready\\r$', flags: 'm' } });
    expect(m.note).toContain('blink ready');
    expect(c.verdict).toBe('pass');
  });

  it('a firmware exception is M601 at the firmware file:line, with the simulation time; the MCU halts', async () => {
    const r = await runLadderAsync(await load('bench/broken/mcu-firmware-exception.bench.ts'));
    expect(r.exitCode).toBe(2);
    const d = r.diagnostics.find(x => x.code === 'M601')! as RunRecord['diagnostics'][number] & { time?: number };
    expect(d).toMatchObject({ severity: 'error', stage: 'tran', at: 'bench/broken/crash.fw.ts:13', subject: { components: ['U1'] } });
    expect(d.time).toBe(1);
    expect(d.message).toMatch(/^U1: firmware threw RangeError: buffer full \(5 readings\)/);
  });

  it('LED straight on a pin: R410 over the 40 mA absolute maximum (exit 1); 68 Ω: R411 warning only (exit 0)', async () => {
    const r = await runLadderAsync(await load('bench/broken/mcu-led-no-resistor.bench.ts'));
    expect(r.exitCode).toBe(1);
    expect(r.firstFailure).toBe('R410');
    const pin = r.stages.tran!.ratings!.find(x => x.code === 'R410')!;
    expect(pin).toMatchObject({ verdict: 'fail', quantity: 'U1.D13.i', limit: 0.04, confidence: 'verified', at: 'bench/broken/mcu-led-no-resistor.bench.ts:12' });
    expect(pin.value).toBeGreaterThan(0.06);
    expect(pin.tFirstViolation).toBeLessThan(1e-7);
    const w = await runLadderAsync(await load('bench/broken/mcu-pin-over-recommended.bench.ts'));
    expect(w.exitCode).toBe(0);
    expect(codes(w)).toEqual(['R411']);
    expect(w.diagnostics[0]).toMatchObject({ severity: 'warning', subject: { components: ['U1'], pins: ['U1.D13'] } });
  });

  it('port-group (R412) and total-current (R413) limits', async () => {
    const g = await runLadderAsync(await load('bench/broken/mcu-port-group-overcurrent.bench.ts'));
    expect(g.exitCode).toBe(1);
    const fails = g.stages.tran!.ratings!.filter(x => x.verdict === 'fail').map(x => x.code);
    expect(fails).toEqual(['R412']);
    const t = await runLadderAsync(await load('bench/broken/mcu-total-current.bench.ts'));
    expect(t.stages.tran!.ratings!.filter(x => x.verdict === 'fail').map(x => [x.code, x.part, x.rating])).toEqual([['R413', 'ATtiny85', 'ΣIOH']]);
    // tb.ratings(false) silences them.
    const off = bench('off', tb => {
      const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(BLINK) }));
      powerMcu(tb, u1);
      const d1 = tb.add('D1', new LED());
      u1.pin('D13').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      tb.ratings(false);
      tb.expect.logic('U1.D13', { tstop: '0.6', maxStep: '10m' }).toBe(1).at('0.25');
    });
    const o = await runLadderAsync(off);
    expect(o.exitCode).toBe(0);
    expect(o.stages.tran!.ratings).toBeUndefined();
  });

  it('brown-out: M622 at the time VCC falls below 2.7 V; the MCU stays in reset (pins high-Z)', async () => {
    const r = await runLadderAsync(await load('bench/broken/mcu-brownout.bench.ts'));
    expect(r.exitCode).toBe(2);
    const d = r.diagnostics.find(x => x.code === 'M622')! as RunRecord['diagnostics'][number] & { time?: number };
    expect(d.time!).toBeGreaterThan(0.7);
    expect(d.time!).toBeLessThan(0.71);
    expect(codes(r)).toContain('M623'); // the supply passed through the 4.5 V recommended minimum first
    // Unpowered at t = 0: never starts.
    const low = bench('low', tb => {
      const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(BLINK) }));
      powerMcu(tb, u1, 2);
      const r1 = tb.add('R1', new Resistor('1k'));
      u1.pin('D13').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      tb.expect.tran({ tstop: '0.6', maxStep: '10m' }).probe('R1.i').toStayBelow('1u');
    });
    const l = await runLadderAsync(low);
    expect(l.exitCode).toBe(2);
    expect(l.diagnostics[0]).toMatchObject({ code: 'M622', time: 0 });
    expect(l.stages.tran!.assertions![0].verdict).toBe('pass'); // high-Z: no current
  });

  it('overvoltage: M623 error above 6 V', async () => {
    const r = await runLadderAsync(await load('bench/broken/mcu-supply-overvoltage.bench.ts'));
    expect(r.exitCode).toBe(2);
    expect(r.diagnostics.find(x => x.code === 'M623')).toMatchObject({ severity: 'error' });
  });

  it('F139: unconnected supply pin (lint, nothing simulated); M608: firmware that does not compile (lint)', async () => {
    const r = await runLadderAsync(await load('bench/broken/mcu-no-supply.bench.ts'));
    expect(r.exitCode).toBe(2);
    expect(codes(r)).toEqual(['F139']);
    expect(r.stages.tran).toMatchObject({ verdict: 'skipped' });
    const s = await runLadderAsync(await load('bench/broken/mcu-firmware-syntax.bench.ts'));
    expect(s.exitCode).toBe(2);
    expect(s.diagnostics[0]).toMatchObject({ code: 'M608', stage: 'lint', at: 'bench/broken/syntax.fw.ts:5' });
  });

  it('firmware lint (F14x) runs in the lint stage with firmware locations', async () => {
    const src = `import { pinMode, digitalWrite, delay, OUTPUT } from 'circuitsvibe/arduino';
export async function setup() { pinMode(13, OUTPUT); }
export async function loop() {
  digitalWrite(13, 1);
  delay(100);
}`;
    const r = await runLadderAsync(
      bench('lint', tb => {
        const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(src) }));
        powerMcu(tb, u1);
        tb.expect.logic('U1.D13', { tstop: '0.1' }).toBe(1);
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.diagnostics[0]).toMatchObject({ code: 'F140', stage: 'lint', at: 'fw/app.fw.ts:5', subject: { components: ['U1'] } });
  });

  it('is deterministic: same bench, byte-identical RunRecords; two MCUs get independent module state', async () => {
    const desc = await load('bench/mcu/uno-button-interrupt.bench.ts');
    expect(JSON.stringify(await runLadderAsync(desc))).toBe(JSON.stringify(await runLadderAsync(desc)));
    const counter = `import { Serial, delay } from 'circuitsvibe/arduino';
let n = 0;
export async function setup() { Serial.begin(9600); }
export async function loop() { n++; Serial.println(n); await delay(10); }`;
    const two = bench('two', tb => {
      const u1 = tb.add('U1', new ArduinoUno({ firmware: fw(counter) }));
      const u2 = tb.add('U2', new ArduinoUno({ firmware: fw(counter) }));
      const v = powerMcu(tb, u1);
      u2.pin('5V').connect(v.pin('+'));
      u2.pin('GND').connect(tb.gnd);
      tb.expect.serial('U1', { tstop: '35m' }).toContain('4\r\n');
      tb.expect.serial('U2').toNotContain('5\r\n');
    });
    const r = await runLadderAsync(two);
    expect(r.exitCode).toBe(0);
    expect(r.stages.tran!.serial!.map(s => s.lines.map(l => l[1]))).toEqual([
      ['1', '2', '3', '4'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('inline { setup, loop } firmware runs; it cannot be exported (T013); runLadder (sync) refuses MCU benches', async () => {
    const desc = bench('inline', tb => {
      const u1 = tb.add('U1', new Mcu({ profile: 'esp32', firmware: { setup: async () => undefined, loop: async () => undefined } }));
      powerMcu(tb, u1, 3.3);
      tb.expect.logic('U1.GPIO2', { tstop: '1m' }).toBe(0);
    });
    const r = await runLadderAsync(desc);
    expect(r.exitCode).toBe(0);
    expect(codes(r)).toContain('M604'); // loop() never awaits: each pass costs 10 µs
    let err: unknown;
    try {
      toCircuitDoc(desc);
    } catch (e) {
      err = e;
    }
    expect(isCircuitDocError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('T013');
    expect(() => runLadder(desc)).toThrow(AsyncAnalysisError);
  });

  it('profiles: ESP32 thresholds at 3.3 V, RP2040 drive, ATtiny85 pins; Part("ArduinoUno")', async () => {
    const src = `import { pinMode, digitalRead, Serial, delay, INPUT } from 'circuitsvibe/arduino';
export async function setup() { Serial.begin(9600); pinMode(4, INPUT); }
export async function loop() { Serial.println(digitalRead(4)); await delay(1); }`;
    const read = async (vin: number) => {
      const r = await runLadderAsync(
        bench('esp', tb => {
          const u1 = tb.add('U1', new Mcu({ profile: 'esp32', firmware: fw(src) }));
          powerMcu(tb, u1, 3.3);
          const vi = tb.add('VI', new VoltageSource(vin));
          vi.pin('-').connect(tb.gnd);
          u1.pin('GPIO4').connect(vi.pin('+'));
          tb.expect.serial('U1', { tstop: '1.5m' }).toHaveLines({ min: 1 });
        }),
      );
      return r.stages.tran!.serial![0].lines[0][1];
    };
    expect(await read(2.6)).toBe('1'); // VIH = 0.75 · 3.3 = 2.475 V
    expect(await read(0.7)).toBe('0'); // VIL = 0.25 · 3.3 = 0.825 V
    expect(MCU_ELECTRICAL.rp2040.drive[0].rHigh).toBeCloseTo(170, 6);
    const tiny = new Mcu({ profile: 'attiny85', firmware: fw(BLINK) });
    expect(tiny.pin('PB1').name).toBe('PB1');
    expect(tiny.pin(1).name).toBe('PB1');
    expect(() => tiny.pin('D13')).toThrow(/has no pin 'D13'/);
    const board = Part('ArduinoUno', { firmware: fw(BLINK) }) as ArduinoUno;
    expect(board.typeName).toBe('ArduinoUno');
    expect(board.pin('5V')).toBe(board.pin('VCC'));
    expect(() => new ArduinoUno({ firmware: './x.fw.ts', profile: 'esp32' } as never)).toThrow(/unknown option 'profile'/);
  });
});
