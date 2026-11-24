import { describe, it, expect } from 'vitest';
import { lintFirmware, getMcuProfile, instrumentLoops, tokenize } from '../../src/mcu';

const BROKEN = `import { pinMode, digitalWrite, digitalRead, analogWrite, analogRead, attachInterrupt, delay, Serial, OUTPUT, HIGH, LOW, RISING } from 'circuitsvibe/arduino';

const LED = 12;
// delay(5) in a comment is fine; 'analogWrite(13, 1)' in a string too
export async function setup() {
  pinMode(LED, OUTPUT);
  attachInterrupt(2, onEdge, RISING);
  Serial.println('hi');
}

function onEdge() {}

export async function loop() {
  analogWrite(LED, 128);
  digitalWrite(7, HIGH);
  delay(100);
  while (digitalRead(4) === LOW) {}
  const t0 = Date.now();
  analogRead(7);
  digitalWrite(20, LOW);
  pulseIn(3, HIGH);
  await delay(10);
}
`;

const BLINK = `import { pinMode, digitalWrite, delay, OUTPUT, HIGH, LOW, LED_BUILTIN, attachInterrupt, digitalPinToInterrupt, FALLING, digitalRead, Serial } from 'circuitsvibe/arduino';

let pressed = false;
export async function setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(2), () => { pressed = true; }, FALLING);
}

async function blink(ms: number) {
  digitalWrite(LED_BUILTIN, HIGH);
  await delay(ms);
  digitalWrite(LED_BUILTIN, LOW);
  return delay(ms);
}

export async function loop() {
  while (digitalRead(3) === LOW) await delay(1);
  await blink(pressed ? 100 : 500);
  for (const ms of [1, 2]) await delay(ms);
}
`;

describe('firmware lint (F140–F149)', () => {
  it('flags each mistake at its line', () => {
    const diags = lintFirmware(BROKEN, { file: 'fw/broken.fw.ts' });
    expect(diags.map(d => `${d.code}@${d.at!.split(':')[1]}`)).toEqual([
      'F145@7',
      'F148@8',
      'F143@14',
      'F149@15',
      'F140@16',
      'F142@17',
      'F147@18',
      'F144@19',
      'F144@20',
      'F146@21',
    ]);
    const byCode = Object.fromEntries(diags.map(d => [d.code, d]));
    expect(byCode.F145.fixes[0]).toMatchObject({ confidence: 'mechanical', detail: 'write `attachInterrupt(digitalPinToInterrupt(2), …)`' });
    expect(byCode.F140.fixes[0].detail).toContain('await delay(100)');
    expect(byCode.F143.message).toContain('D12 has no PWM');
    expect(diags.every(d => d.stage === 'lint' && d.at!.startsWith('fw/broken.fw.ts:'))).toBe(true);
  });

  it('accepts idiomatic firmware (awaited delays, returned delays, polling with await)', () => {
    expect(lintFirmware(BLINK, { file: 'blink.fw.ts' })).toEqual([]);
  });

  it('checks pins against the selected profile', () => {
    const src = `import { pinMode, analogWrite, OUTPUT } from 'circuitsvibe/arduino';
export async function setup() { pinMode(34, OUTPUT); analogWrite(25, 10); }
export async function loop() {}
`;
    const esp = lintFirmware(src, { profile: getMcuProfile('esp32') });
    expect(esp.map(d => d.code)).toEqual(['F144']); // GPIO34 is input-only; GPIO25 has LEDC PWM
    const uno = lintFirmware(src);
    expect(uno.map(d => d.code)).toEqual(['F144', 'F144']); // neither 34 nor 25 exists on the Uno
  });

  it('missing entry points ⇒ F141', () => {
    expect(lintFirmware('export function setup() {}\n').map(d => [d.code, d.severity])).toEqual([['F141', 'warning']]);
    expect(lintFirmware('function loop() {}\n').map(d => [d.code, d.severity])).toEqual([['F141', 'error']]);
    expect(lintFirmware('async function loop() {}\nfunction setup() {}\nexport { setup, loop };\n')).toEqual([]);
  });
});

describe('loop instrumentation', () => {
  it('guards while / for / do-while conditions without changing line numbers', () => {
    const src = `while (a < b) { x++; }
for (let i = 0; i < n; i++) f(i);
for (;;) break;
do { y--; } while (y > 0)
for (const v of list) g(v);
for (const k in obj) h(k);
obj.while(1); s = "while (x)"; r = /for (;;)/g; // while (c)
t = \`\${ (() => { while (q) {} })() } while (z)\`;
`;
    const out = instrumentLoops(src);
    expect(out.split('\n')).toEqual([
      'while (__cvLoopGuard() && (a < b)) { x++; }',
      'for (let i = 0; __cvLoopGuard() && ( i < n); i++) f(i);',
      'for (; __cvLoopGuard();) break;',
      'do { y--; } while (__cvLoopGuard() && (y > 0))',
      'for (const v of list) g(v);',
      'for (const k in obj) h(k);',
      'obj.while(1); s = "while (x)"; r = /for (;;)/g; // while (c)',
      't = `${ (() => { while (__cvLoopGuard() && (q)) {} })() } while (z)`;',
      '',
    ]);
  });

  it('tokenizes regex vs division by context', () => {
    const kinds = tokenize('a = b / c / d; e = /x/.test(s); return /y/;').filter(t => t.type === 'regex').map(t => t.text);
    expect(kinds).toEqual(['/x/', '/y/']);
  });
});
