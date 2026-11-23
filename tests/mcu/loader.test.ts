import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadFirmwareFile, loadFirmwareSource } from '../../src/mcu/node/load-firmware';
import { McuRuntime, MockPinBus, measure, type Firmware } from '../../src/mcu';

// Firmware evaluated exactly like the CLI will: sucrase + vm under the real
// filename, loops instrumented. Locations must be the firmware file's lines.

let dir: string;
const write = (rel: string, content: string): string => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const loc = (file: string, line: number) => `${file.replace(/\\/g, '/')}:${line}`;

function load(file: string, profile?: string): Firmware {
  const r = loadFirmwareFile(file, profile ? { profile } : {});
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostic));
  return r.firmware;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv mcu '));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const BLINK = `import { pinMode, digitalWrite, delay, OUTPUT, HIGH, LOW, LED_BUILTIN, millis, Serial } from 'circuitsvibe/arduino';
import { HALF } from './timing';

let toggles: number = 0;

export async function setup(): Promise<void> {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

export async function loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  await delay(HALF);
  digitalWrite(LED_BUILTIN, LOW);
  await delay(HALF);
  toggles += 2;
  if (millis() >= 2000) throw new Error(\`gave up after \${toggles} toggles\`);
}
`;

describe('firmware loader (CLI path)', () => {
  it('runs TS firmware with relative imports; an exception maps to the firmware file:line and sim time', async () => {
    write('timing.ts', 'export const HALF: number = 250;\n');
    const file = write('blink.fw.ts', BLINK);
    const fw = load(file);
    expect(fw.entryLocs).toEqual({ setup: loc(file, 6), loop: loc(file, 11) });

    const rt = new McuRuntime({ profile: 'atmega328p', firmware: fw, bus: new MockPinBus() });
    await rt.runUntil(5);
    expect(measure.toggleCount(measure.levelsOf(rt.pinTrace(), 'D13'))).toBe(8);
    const [d] = rt.diagnostics();
    expect(d).toMatchObject({ code: 'M601', time: 2, at: loc(file, 17) });
    expect(d.message).toContain('gave up after 8 toggles');
    expect((d.evidence?.stack as string[])[0]).toContain(loc(file, 17));
  });

  it('instrumented loops make even API-free infinite loops detectable (M602 at the loop line)', async () => {
    const file = write(
      'spin.fw.ts',
      `export async function setup() {
  let x = 0;
  while (true) {
    x++;
  }
}
`,
    );
    const rt = new McuRuntime({ profile: 'atmega328p', firmware: load(file), bus: new MockPinBus(), maxOpsPerYield: 10_000 });
    await rt.runUntil(1);
    expect(rt.diagnostics().map(d => [d.code, d.at])).toEqual([['M602', loc(file, 3)]]);
  });

  it('for(;;) and do/while loops are guarded too', async () => {
    for (const body of ['for (;;) {}', 'let i = 0; do { i++; } while (i >= 0);']) {
      const file = write('spin2.fw.ts', `export function loop() {\n  ${body}\n}\n`);
      const rt = new McuRuntime({ profile: 'atmega328p', firmware: load(file), bus: new MockPinBus(), maxOpsPerYield: 5000 });
      await rt.runUntil(0.1);
      expect(rt.diagnostics().map(d => [d.code, d.at])).toEqual([['M602', loc(file, 2)]]);
    }
  });

  it('each load has its own module state, and top-level constants follow the load profile', async () => {
    const file = write(
      'counter.fw.ts',
      `import { pinMode, OUTPUT, LED_BUILTIN, delay } from 'circuitsvibe/arduino';
const LED = LED_BUILTIN;
export let count = 0;
export async function setup() { pinMode(LED, OUTPUT); }
export async function loop() { count++; await delay(100); }
`,
    );
    const a = loadFirmwareFile(file, { profile: 'attiny85' });
    const b = loadFirmwareFile(file);
    if (!a.ok || !b.ok) throw new Error('load failed');
    const busA = new MockPinBus();
    const rtA = new McuRuntime({ profile: 'attiny85', firmware: a.firmware, bus: busA });
    const rtB = new McuRuntime({ profile: 'atmega328p', firmware: b.firmware, bus: new MockPinBus() });
    await rtA.runUntil(1);
    await rtB.runUntil(0.3);
    expect(busA.calls[0]).toEqual({ kind: 'dir', pin: 'PB1', t: 0, dir: 'output' }); // ATtiny85 LED_BUILTIN = PB1
    expect(rtB.pinTrace()[0]).toMatchObject({ pin: 'D13', kind: 'dir' });
    expect(rtA.diagnostics()).toEqual([]);
  });

  it('compile errors ⇒ M608 with the firmware line', () => {
    const r = loadFirmwareSource('export async function loop() {\n  const x: number = ;\n}\n', path.join(dir, 'bad.fw.ts'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostic).toMatchObject({ code: 'M608', slug: 'firmware-load-error', at: loc(path.join(dir, 'bad.fw.ts'), 2) });
  });

  it('await in a non-async function ⇒ M608 with a hint', () => {
    const file = path.join(dir, 'sync.fw.ts');
    const r = loadFirmwareSource("import { delay } from 'circuitsvibe/arduino';\nexport function loop() {\n  await delay(1);\n}\n", file);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostic.message).toMatch(/async/);
    expect(r.diagnostic.at).toMatch(/sync\.fw\.ts:\d+$/);
  });

  it('host modules and top-level API calls are rejected with M608', () => {
    const r1 = loadFirmwareSource("import * as fs from 'node:fs';\nexport function loop() { fs.existsSync('x'); }\n", path.join(dir, 'host.fw.ts'));
    expect(!r1.ok && r1.diagnostic.message).toMatch(/may only import 'circuitsvibe\/arduino'/);
    const file = path.join(dir, 'top.fw.ts');
    const r2 = loadFirmwareSource("import { pinMode } from 'circuitsvibe/arduino';\n\npinMode(13, 1);\nexport function loop() {}\n", file);
    expect(!r2.ok && r2.diagnostic).toMatchObject({ code: 'M608', at: loc(file, 3) });
    const r3 = loadFirmwareFile(path.join(dir, 'missing.fw.ts'));
    expect(!r3.ok && r3.diagnostic.code).toBe('M608');
  });
});
