import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McuRuntime, MockPinBus, measure, type Firmware, type McuRuntimeOptions } from '../../src/mcu';
import {
  pinMode, digitalWrite, digitalRead, analogRead, analogWrite, analogReference, analogReadResolution,
  millis, micros, delay, delayMicroseconds, attachInterrupt, digitalPinToInterrupt, noInterrupts, interrupts,
  tone, Serial, Timer1, random, randomSeed, map, constrain,
  OUTPUT, INPUT, INPUT_PULLUP, HIGH, LOW, RISING, FALLING, CHANGE, LED_BUILTIN, A0, INTERNAL, HEX,
} from '../../src/mcu/arduino';

const { levelsOf, pwmStats, serialLines, serialFirstTime, toggleCount } = measure;

function mcu(firmware: Firmware, opts: Partial<McuRuntimeOptions> = {}) {
  const bus = (opts.bus as MockPinBus | undefined) ?? new MockPinBus({ vcc: 5 });
  const rt = new McuRuntime({ profile: 'atmega328p', firmware, bus, ...opts });
  return { rt, bus };
}

const codes = (rt: McuRuntime) => rt.diagnostics().map(d => d.code);

// file:line of the unique source line containing `needle` in this test file.
const SRC = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
const lineWith = (needle: string) => `tests/mcu/runtime.test.ts:${SRC.findIndex(l => l.includes(needle) && !l.includes('lineWith')) + 1}`;

describe('time and delay()', () => {
  it('blink with delay(500) toggles at exactly 0.5 s steps', async () => {
    const { rt } = mcu({
      async setup() {
        pinMode(LED_BUILTIN, OUTPUT);
      },
      async loop() {
        digitalWrite(LED_BUILTIN, HIGH);
        await delay(500);
        digitalWrite(LED_BUILTIN, LOW);
        await delay(500);
      },
    });
    await rt.runUntil(3);
    const levels = levelsOf(rt.pinTrace(), 'D13');
    expect(levels).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3].map((t, i) => ({ t, level: i % 2 === 0 ? 1 : 0 })));
    expect(rt.diagnostics()).toEqual([]);
    expect(rt.now).toBe(3);
  });

  it('exposes the next wake time as a co-simulation breakpoint', async () => {
    const { rt } = mcu({
      async loop() {
        digitalWrite(13, HIGH);
        await delay(500);
      },
    });
    expect(rt.nextWakeTime()).toBe(0); // setup/loop not started yet
    const breakpoints: number[] = [];
    let t = 0;
    while (t < 2) {
      const next = Math.min(rt.nextWakeTime(), 2);
      await rt.runUntil(next);
      breakpoints.push(next);
      t = next;
    }
    expect(breakpoints).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(rt.nextWakeTime()).toBe(2.5);
  });

  it('millis()/micros() advance only with simulated time (micros at 4 µs granularity on the Uno)', async () => {
    const seen: number[][] = [];
    const { rt } = mcu({
      async setup() {
        seen.push([millis(), micros()]);
        let x = 0;
        for (let i = 0; i < 200_000; i++) x += Math.sqrt(i); // wall-clock work, zero simulated time
        seen.push([millis(), micros(), x > 0 ? 1 : 0]);
        await delay(1234);
        seen.push([millis(), micros()]);
        await delayMicroseconds(10);
        seen.push([millis(), micros()]);
      },
    });
    await rt.runUntil(5);
    expect(seen).toEqual([
      [0, 0],
      [0, 0, 1],
      [1234, 1_234_000],
      [1234, 1_234_008], // 1 234 010 µs floored to the 4 µs tick
    ]);
  });

  it('runUntil is monotonic and must not be re-entered', async () => {
    const { rt } = mcu({ async loop() { await delay(10); } });
    await rt.runUntil(0.1);
    await expect(rt.runUntil(0.05)).rejects.toThrow(/before the firmware's current time/);
    const a = rt.runUntil(0.2);
    await expect(rt.runUntil(0.3)).rejects.toThrow(/already running/);
    await a;
  });

  it('two runtimes run independently with the ambient API', async () => {
    const make = (pin: number, ms: number): Firmware => ({
      async loop() {
        digitalWrite(pin, HIGH);
        await delay(ms);
        digitalWrite(pin, LOW);
        await delay(ms);
      },
      async setup() {
        pinMode(pin, OUTPUT);
      },
    });
    const a = mcu(make(13, 100), { id: 'U1' });
    const b = mcu(make(12, 250), { id: 'U2' });
    for (const t of [0.1, 0.25, 0.5, 1]) {
      await a.rt.runUntil(t);
      await b.rt.runUntil(t);
    }
    expect(toggleCount(levelsOf(a.rt.pinTrace(), 'D13'))).toBe(11);
    expect(toggleCount(levelsOf(b.rt.pinTrace(), 'D12'))).toBe(5);
  });
});

describe('analogRead()', () => {
  it('quantizes like the AVR datasheet: ADC = floor(Vin·1024/Vref), clamped to 0..1023', async () => {
    const readings: number[] = [];
    const volts = [0, 0.00488, 5 / 1024, 2.5, 2.49, 4.999, 5, 6, -0.3];
    const bus = new MockPinBus();
    let i = 0;
    bus.setVoltage('A0', () => volts[i]);
    const { rt } = mcu(
      {
        async setup() {
          for (i = 0; i < volts.length; i++) readings.push(analogRead(A0));
          readings.push(analogRead(0)); // analogRead(0) means A0 on AVR
        },
      },
      { bus },
    );
    await rt.runUntil(0);
    expect(readings).toEqual([0, 0, 1, 512, 509, 1023, 1023, 1023, 0, 0]);
    const clamped = rt.diagnostics().filter(d => d.code === 'M616');
    expect(clamped).toHaveLength(1);
    expect(clamped[0].evidence?.occurrences).toBe(2);
  });

  it('honours analogReference(INTERNAL) = 1.1 V on the ATmega328P', async () => {
    const bus = new MockPinBus().setVoltage('A1', 0.55);
    let r = 0;
    const { rt } = mcu({ async setup() { analogReference(INTERNAL); r = analogRead(15); } }, { bus });
    await rt.runUntil(0);
    expect(r).toBe(512);
  });

  it('RP2040 reads 10 bits by default (arduino-pico) and 12 after analogReadResolution(12)', async () => {
    const bus = new MockPinBus({ vcc: 3.3 }).setVoltage('GP26', 1.65);
    const r: number[] = [];
    const rt = new McuRuntime({
      profile: 'rp2040',
      bus,
      firmware: {
        async setup() {
          r.push(analogRead(26));
          analogReadResolution(12);
          r.push(analogRead(26));
        },
      },
    });
    await rt.runUntil(0);
    expect(r).toEqual([512, 2048]);
  });

  it('analogRead on a pin without ADC ⇒ M613', async () => {
    const { rt } = mcu({ async setup() { analogRead('D7'); } });
    await rt.runUntil(0);
    const d = rt.diagnostics()[0];
    expect(d.code).toBe('M613');
    expect(d.at).toMatch(/tests\/mcu\/runtime\.test\.ts:\d+$/);
  });
});

describe('analogWrite() / PWM', () => {
  it('analogWrite(9, 128) on the Uno ⇒ 490.196 Hz at 128/255 = 50.2 % duty', async () => {
    const { rt } = mcu({ async setup() { analogWrite(9, 128); } });
    await rt.runUntil(0.2);
    const stats = pwmStats(levelsOf(rt.pinTrace(), 'D9'), { from: 0.05, to: 0.2 })!;
    expect(stats.frequency).toBeCloseTo(16e6 / 64 / 510, 6); // 490.196 Hz
    expect(stats.duty).toBeCloseTo(128 / 255, 6); // 0.50196
    expect(stats.periods).toBeGreaterThan(70);
    expect(rt.diagnostics()).toEqual([]);
  });

  it('pins 5/6 run Timer0 fast PWM at 976.5625 Hz with (v+1)/256 duty', async () => {
    const { rt } = mcu({ async setup() { analogWrite(5, 128); } });
    await rt.runUntil(0.1);
    const stats = pwmStats(levelsOf(rt.pinTrace(), 'D5'), { from: 0.01 })!;
    expect(stats.frequency).toBeCloseTo(976.5625, 6);
    expect(stats.duty).toBeCloseTo(129 / 256, 6);
  });

  it('PWM edges are wake times; duty changes apply at the next period; 0/255 are constant levels', async () => {
    const { rt } = mcu({
      async setup() {
        analogWrite(9, 64);
        await delay(10);
        analogWrite(9, 191);
        await delay(10);
        analogWrite(9, 255);
        await delay(10);
        analogWrite(9, 0);
      },
    });
    await rt.runUntil(0);
    expect(rt.nextWakeTime()).toBeCloseTo(0.000512, 12); // falling edge: 64/255 of the 2040 µs period
    await rt.runUntil(0.04);
    const lv = levelsOf(rt.pinTrace(), 'D9');
    expect(pwmStats(lv, { from: 0.0005, to: 0.0095 })!.duty).toBeCloseTo(64 / 255, 6);
    expect(pwmStats(lv, { from: 0.0105, to: 0.0195 })!.duty).toBeCloseTo(191 / 255, 6);
    expect(measure.levelAt(lv, 0.025)).toBe(1);
    expect(measure.levelAt(lv, 0.035)).toBe(0);
    expect(rt.nextWakeTime()).toBe(Infinity);
  });

  it('descriptor mode hands the integrator one setPwm per change instead of edges', async () => {
    const bus = new MockPinBus();
    const { rt } = mcu({ async setup() { analogWrite(10, 128); await delay(5); analogWrite(10, 0); } }, { bus, pwm: 'descriptor' });
    await rt.runUntil(0.01);
    const pwm = bus.calls.filter(c => c.kind === 'pwm');
    expect(pwm).toHaveLength(2);
    expect(pwm[0]).toMatchObject({ pin: 'D10', t: 0, pwm: { freqHz: 16e6 / 64 / 510, periodStart: 0 } });
    expect((pwm[0] as { pwm: { duty: number } }).pwm.duty).toBeCloseTo(128 / 255, 6);
    expect(pwm[1]).toMatchObject({ pin: 'D10', t: 0.005, pwm: null });
    expect(bus.drivesOf('D10').at(-1)).toEqual({ t: 0.005, level: 0 });
  });

  it('analogWrite on a non-PWM pin ⇒ M612 at the firmware line, with the core fallback', async () => {
    const { rt, bus } = mcu({
      async setup() {
        analogWrite(13, 200);
      },
    });
    await rt.runUntil(0.01);
    const [d] = rt.diagnostics();
    expect(d).toMatchObject({ code: 'M612', slug: 'no-pwm-on-pin', severity: 'error', stage: 'mcu', time: 0, subject: { mcu: 'U1', pins: ['D13'], api: 'analogWrite' } });
    expect(d.at).toBe(lineWith('analogWrite(13, 200)'));
    expect(d.fixes[0].detail).toContain('D3, D5, D6, D9, D10, D11');
    expect(bus.drivesOf('D13')).toEqual([{ t: 0, level: 1 }]); // ≥ 128 ⇒ HIGH, like ArduinoCore-avr
  });

  it('ESP32 LEDC defaults to 1 kHz, v/256 duty', async () => {
    const rt = new McuRuntime({ profile: 'esp32', bus: new MockPinBus({ vcc: 3.3 }), firmware: { async setup() { analogWrite(2, 128); } } });
    await rt.runUntil(0.02);
    const s = pwmStats(levelsOf(rt.pinTrace(), 'GPIO2'))!;
    expect(s.frequency).toBeCloseTo(1000, 6);
    expect(s.duty).toBeCloseTo(0.5, 6);
  });

  it('tone() makes a 50 % square wave and stops after its duration', async () => {
    const { rt } = mcu({ async setup() { tone(8, 1000, 50); } });
    await rt.runUntil(0.1);
    const lv = levelsOf(rt.pinTrace(), 'D8');
    const s = pwmStats(lv)!;
    expect(s.frequency).toBeCloseTo(1000, 6);
    expect(s.duty).toBeCloseTo(0.5, 6);
    expect(toggleCount(lv)).toBe(100); // 50 periods, the last falling edge at 49.5 ms
    expect(lv.at(-1)).toEqual({ t: 0.0495, level: 0 });
    expect(rt.nextWakeTime()).toBe(Infinity);
  });
});

describe('digital I/O', () => {
  it('digitalRead follows the bus; INPUT_PULLUP reaches the bus as a direction', async () => {
    const bus = new MockPinBus().setInputWaveform('D4', [[0, 0], [0.5, 1]]);
    const seen: number[] = [];
    const { rt } = mcu(
      {
        async setup() {
          pinMode(4, INPUT);
          pinMode(7, INPUT_PULLUP);
        },
        async loop() {
          seen.push(digitalRead(4), digitalRead(7));
          await delay(400);
        },
      },
      { bus },
    );
    await rt.runUntil(1);
    expect(seen).toEqual([0, 1, 0, 1, 1, 1]);
    expect(bus.calls.filter(c => c.kind === 'dir')).toEqual([{ kind: 'dir', pin: 'D7', t: 0, dir: 'input_pullup' }]);
  });

  it('digitalWrite without pinMode(OUTPUT) ⇒ M615; on AVR it toggles the pull-up', async () => {
    const { rt, bus } = mcu({ async setup() { digitalWrite(13, HIGH); } });
    await rt.runUntil(0);
    expect(codes(rt)).toEqual(['M615']);
    expect(rt.diagnostics()[0].fixes[0]).toMatchObject({ confidence: 'mechanical', detail: 'call `pinMode(13, OUTPUT)` in setup() before writing' });
    expect(bus.calls).toEqual([{ kind: 'dir', pin: 'D13', t: 0, dir: 'input_pullup' }]);
  });

  it('unknown pins and input-only pins are diagnosed (M610, M611)', async () => {
    const rt = new McuRuntime({
      profile: 'esp32',
      bus: new MockPinBus({ vcc: 3.3 }),
      firmware: {
        async setup() {
          pinMode(34, OUTPUT); // input-only
          digitalWrite(40, HIGH); // does not exist
        },
      },
    });
    await rt.runUntil(0);
    expect(codes(rt)).toEqual(['M611', 'M610']);
  });
});

describe('interrupts', () => {
  it('attachInterrupt RISING fires once per rising edge, at the edge time', async () => {
    const bus = new MockPinBus().pulseTrain('D2', { t0: 0.01, period: 0.01, high: 0.002, count: 5 });
    const hits: number[] = [];
    const { rt } = mcu(
      {
        async setup() {
          pinMode(2, INPUT);
          attachInterrupt(digitalPinToInterrupt(2), () => hits.push(micros()), RISING);
        },
        async loop() {
          await delay(1000);
        },
      },
      { bus },
    );
    expect(rt.nextWakeTime()).toBe(0);
    await rt.runUntil(0);
    expect(rt.nextWakeTime()).toBeCloseTo(0.01, 12); // the queued edge is a breakpoint
    await rt.runUntil(0.1);
    expect(hits).toEqual([10_000, 20_000, 30_000, 40_000, 50_000]);
  });

  it('edges reported by the bus during co-simulation reach FALLING/CHANGE handlers', async () => {
    const bus = new MockPinBus().setInput('D3', 1, 0);
    let falling = 0;
    let change = 0;
    const { rt } = mcu(
      {
        async setup() {
          pinMode(3, INPUT_PULLUP);
          attachInterrupt(1, () => falling++, FALLING); // interrupt 1 = D3
          attachInterrupt(0, () => change++, CHANGE); // interrupt 0 = D2, never toggles
        },
      },
      { bus },
    );
    await rt.runUntil(0.05);
    bus.setInput('D3', 0, 0.06).setInput('D3', 1, 0.07).setInput('D3', 0, 0.08);
    await rt.runUntil(0.1);
    expect(falling).toBe(2);
    expect(change).toBe(0);
    expect(() => bus.setInput('D3', 1, 0.09)).toThrow(/before the MCU's current time/);
  });

  it('noInterrupts() defers a pending interrupt until interrupts()', async () => {
    const bus = new MockPinBus().setInput('D2', 1, 0.005);
    const order: string[] = [];
    const { rt } = mcu(
      {
        async setup() {
          attachInterrupt(0, () => order.push(`isr@${millis()}`), RISING);
          noInterrupts();
          await delay(10);
          order.push('enable');
          interrupts();
        },
      },
      { bus },
    );
    await rt.runUntil(0.02);
    expect(order).toEqual(['enable', 'isr@10']);
  });

  it('attachInterrupt(2, …) on the Uno ⇒ M614 with a mechanical digitalPinToInterrupt fix', async () => {
    const { rt } = mcu({ async setup() { attachInterrupt(2, () => {}, RISING); } });
    await rt.runUntil(0);
    const [d] = rt.diagnostics();
    expect(d.code).toBe('M614');
    expect(d.fixes[0]).toMatchObject({ confidence: 'mechanical', detail: 'write `attachInterrupt(digitalPinToInterrupt(2), …)`' });
  });

  it('delay() inside an interrupt handler ⇒ M607 (ignored)', async () => {
    const bus = new MockPinBus().setInput('D2', 1, 0.001);
    const { rt } = mcu(
      {
        async setup() {
          attachInterrupt(0, () => { void delay(5); }, RISING);
        },
        async loop() {
          await delay(100);
        },
      },
      { bus },
    );
    await rt.runUntil(0.01);
    expect(codes(rt)).toEqual(['M607']);
    expect(rt.state).toBe('running');
  });

  it('Timer1 fires its callback every period', async () => {
    let ticks = 0;
    const { rt } = mcu({
      async setup() {
        Timer1.initialize(1000);
        Timer1.attachInterrupt(() => ticks++);
      },
      async loop() {
        await delay(1000);
      },
    });
    await rt.runUntil(0.0105);
    expect(ticks).toBe(10);
    expect(rt.nextWakeTime()).toBeCloseTo(0.011, 12);
  });

  it('Timer1 together with analogWrite on D9/D10 ⇒ M621', async () => {
    const { rt } = mcu({ async setup() { Timer1.initialize(500); analogWrite(10, 100); } });
    await rt.runUntil(0);
    expect(codes(rt)).toEqual(['M621']);
  });
});

describe('Serial', () => {
  it('captures print/println with simulation timestamps', async () => {
    const { rt } = mcu({
      async setup() {
        Serial.begin(115200);
        Serial.println('ready');
      },
      async loop() {
        Serial.print('t=');
        Serial.println(millis());
        await delay(100);
      },
    });
    await rt.runUntil(0.35);
    const log = rt.serialLog();
    expect(log.slice(0, 3)).toEqual([
      { t: 0, port: 'Serial', text: 'ready\r\n' },
      { t: 0, port: 'Serial', text: 't=' },
      { t: 0, port: 'Serial', text: '0\r\n' },
    ]);
    expect(serialLines(log).map(l => [l.t, l.text])).toEqual([
      [0, 'ready'],
      [0, 't=0'],
      [0.1, 't=100'],
      [0.2, 't=200'],
      [0.3, 't=300'],
    ]);
    expect(serialFirstTime(log, 't=200')).toBe(0.2);
    expect(rt.diagnostics()).toEqual([]);
  });

  it('formats numbers like Arduino Print', async () => {
    const { rt } = mcu({
      async setup() {
        Serial.begin(9600);
        Serial.print(3.14159);
        Serial.print(' ');
        Serial.print(3.14159, 4);
        Serial.print(' ');
        Serial.print(255, HEX);
        Serial.print(' ');
        Serial.print(true);
        Serial.write(65);
      },
    });
    await rt.runUntil(0);
    expect(measure.serialText(rt.serialLog())).toBe('3.14 3.1416 FF 1A');
  });

  it('Serial.print before Serial.begin ⇒ M617 (still recorded)', async () => {
    const { rt } = mcu({ async setup() { Serial.println('x'); Serial.println('y'); } });
    await rt.runUntil(0);
    expect(codes(rt)).toEqual(['M617']);
    expect(rt.serialLog()).toHaveLength(2);
  });

  it('serialInput feeds Serial.available()/read() at its arrival time', async () => {
    const got: number[] = [];
    const { rt } = mcu({
      async setup() { Serial.begin(9600); },
      async loop() {
        while (Serial.available() > 0) got.push(Serial.read());
        await delay(10);
      },
    });
    rt.serialInput('AB', 0.015);
    await rt.runUntil(0.05);
    expect(got).toEqual([65, 66]);
  });
});

describe('runaway firmware never hangs the simulator', () => {
  it('a synchronous polling loop ⇒ M602 at the loop line, MCU halted', async () => {
    const { rt } = mcu(
      {
        async loop() {
          while (digitalRead(2) === LOW) {
            // waits for a button — but time cannot advance in here
          }
        },
      },
      { maxOpsPerYield: 10_000 },
    );
    await rt.runUntil(1);
    const [d] = rt.diagnostics();
    expect(d.code).toBe('M602');
    expect(d.at).toBe(lineWith('while (digitalRead(2) === LOW)'));
    expect(d.time).toBe(0);
    expect(rt.state).toBe('halted');
    expect(rt.nextWakeTime()).toBe(Infinity);
  });

  it('loop() without delay is charged idleLoopUs per pass (M604 once) and still sees inputs', async () => {
    const bus = new MockPinBus().setInput('D2', 1, 0.0005);
    let passes = 0;
    let sawAt = -1;
    const { rt } = mcu(
      {
        async setup() { pinMode(13, OUTPUT); },
        async loop() {
          passes++;
          if (digitalRead(2) && sawAt < 0) sawAt = micros();
        },
      },
      { bus },
    );
    await rt.runUntil(0.001);
    expect(passes).toBe(101); // t = 0, 10 µs, …, 1000 µs
    expect(sawAt).toBe(500);
    expect(codes(rt)).toEqual(['M604']);
    expect(rt.nextWakeTime()).toBeCloseTo(0.00101, 12);
  });

  it('a delay(0) loop that never lets time advance ⇒ M603', async () => {
    const { rt } = mcu(
      {
        async setup() {
          for (;;) await delay(0);
        },
      },
      { maxEventsPerInstant: 1000 },
    );
    await rt.runUntil(1);
    expect(codes(rt)).toEqual(['M603']);
    expect(rt.state).toBe('halted');
  });

  it('delay() without await ⇒ M605 at the un-awaited call', async () => {
    const { rt } = mcu({
      async setup() { pinMode(13, OUTPUT); },
      async loop() {
        digitalWrite(13, HIGH);
        void delay(500); // the bug: no await
        digitalWrite(13, LOW);
        await delay(500);
      },
    });
    await rt.runUntil(2);
    const [d] = rt.diagnostics();
    expect(d.code).toBe('M605');
    expect(d.at).toBe(lineWith('void delay(500); // the bug'));
    expect(d.fixes[0].confidence).toBe('mechanical');
    expect(rt.state).toBe('halted');
  });

  it('an async helper started without await ⇒ M605 (no second thread)', async () => {
    async function blinkForever() {
      for (;;) {
        digitalWrite(13, HIGH);
        await delay(100);
        digitalWrite(13, LOW);
        await delay(100); // runs detached once setup() is waiting
      }
    }
    const { rt } = mcu({
      async setup() {
        pinMode(13, OUTPUT);
        void blinkForever();
      },
      async loop() {
        await delay(1000);
      },
    });
    await rt.runUntil(1);
    expect(codes(rt)).toEqual(['M605']);
    expect(rt.state).toBe('halted');
  });

  it('awaiting a foreign promise ⇒ M606 instead of a hang', async () => {
    const { rt } = mcu({
      async setup() {
        await new Promise(() => {});
      },
    });
    await rt.runUntil(1);
    expect(codes(rt)).toEqual(['M606']);
  });

  it('a firmware exception ⇒ M601 with location and simulation time', async () => {
    const { rt } = mcu({
      async loop() {
        await delay(250);
        if (millis() >= 1000) throw new RangeError('sensor timeout');
      },
    });
    await rt.runUntil(5);
    const [d] = rt.diagnostics();
    expect(d).toMatchObject({ code: 'M601', time: 1, severity: 'error' });
    expect(d.message).toBe('firmware threw RangeError: sensor timeout (in main, t=1 s)');
    expect(d.at).toBe(lineWith("throw new RangeError('sensor timeout')"));
    expect(rt.state).toBe('halted');
  });

  it('missing setup and loop ⇒ M609', async () => {
    const { rt } = mcu({});
    await rt.runUntil(1);
    expect(codes(rt)).toEqual(['M609']);
  });
});

describe('determinism and randomness', () => {
  const busy: Firmware = {
    async setup() {
      Serial.begin(9600);
      pinMode(13, OUTPUT);
      analogWrite(9, random(1, 255));
    },
    async loop() {
      digitalWrite(13, random(2));
      Serial.println(random(1000));
      await delay(random(5, 50));
    },
  };

  it('two runs produce identical traces, serial logs and diagnostics', async () => {
    const run = async () => {
      const bus = new MockPinBus();
      const rt = new McuRuntime({ profile: 'atmega328p', firmware: busy, bus });
      for (const t of [0.013, 0.2, 0.5, 1]) await rt.runUntil(t);
      return JSON.stringify({ trace: rt.pinTrace(), serial: rt.serialLog(), diags: rt.diagnostics(), calls: bus.calls });
    };
    const a = await run();
    const b = await run();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(10_000);
  });

  it('random() follows avr-libc: reproducible per seed, different across seeds', async () => {
    const draw = async (seed?: number, cfg?: number) => {
      const out: number[] = [];
      const { rt } = mcu(
        {
          async setup() {
            if (seed !== undefined) randomSeed(seed);
            for (let i = 0; i < 8; i++) out.push(random(100));
            out.push(random(10, 20));
          },
        },
        cfg === undefined ? {} : { randomSeed: cfg },
      );
      await rt.runUntil(0);
      return out;
    };
    const reset = await draw();
    expect(reset[0]).toBe(16807 % 100); // first avr-libc random() after reset is 16807
    expect(await draw()).toEqual(reset);
    expect(await draw(42)).toEqual(await draw(42));
    expect(await draw(42)).not.toEqual(await draw(43));
    expect(await draw(undefined, 42)).toEqual(await draw(42));
    expect((await draw(7)).every(v => v >= 0 && v < 100)).toBe(true);
  });

  it('map() and constrain() follow Arduino integer semantics', () => {
    expect(map(512, 0, 1023, 0, 255)).toBe(127);
    expect(map(-5, 0, 10, 0, 100)).toBe(-50);
    expect(map(3, 0, 7, 0, 10)).toBe(4); // 30/7 truncated
    expect(constrain(300, 0, 255)).toBe(255);
    expect(constrain(-1, 0, 255)).toBe(0);
  });
});

describe('other profiles', () => {
  it('ATtiny85: PWM on PB0 at ≈488 Hz, INT0 on PB2, PB5 (RESET) is not an output', async () => {
    const bus = new MockPinBus().setInput('PB2', 1, 0.002);
    let irq = 0;
    const rt = new McuRuntime({
      profile: 'attiny85',
      bus,
      firmware: {
        async setup() {
          analogWrite(0, 100);
          attachInterrupt(0, () => irq++, RISING);
          pinMode(5, OUTPUT);
          expect(LED_BUILTIN).toBe(1);
        },
      },
    });
    await rt.runUntil(0.05);
    expect(pwmStats(levelsOf(rt.pinTrace(), 'PB0'))!.frequency).toBeCloseTo(488.28125, 6);
    expect(irq).toBe(1);
    expect(codes(rt)).toEqual(['M611']);
  });
});
