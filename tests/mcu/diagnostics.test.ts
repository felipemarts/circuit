import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { MCU_CODES, measure, MCU_PROFILES, getMcuProfile } from '../../src/mcu';
import { DIAGNOSTIC_DOCS } from '../../src/verify/registry';

describe('MCU diagnostic codes', () => {
  it('stay inside the owned ranges and are registered with matching slugs and documented', () => {
    const docs = fs.readFileSync('docs/DIAGNOSTICS.md', 'utf8');
    for (const [code, info] of Object.entries(MCU_CODES)) {
      expect(code).toMatch(/^(M6(0[1-9]|[1-4]\d)|F14\d)$/);
      const doc = DIAGNOSTIC_DOCS.find(d => d.code === code);
      expect(doc, code).toBeDefined();
      expect(doc!.slug).toBe(info.slug);
      expect(doc!.explanation.length).toBeGreaterThan(80);
      expect(docs).toContain(`| \`${code}\` | ${info.slug} |`);
    }
    expect(new Set(DIAGNOSTIC_DOCS.map(d => d.code)).size).toBe(DIAGNOSTIC_DOCS.length);
  });
});

describe('profiles', () => {
  it('are plain JSON data with consistent pin tables', () => {
    for (const p of Object.values(MCU_PROFILES)) {
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
      const names = new Set(p.pins.map(x => x.name));
      expect(names.size).toBe(p.pins.length);
      for (const n of [...Object.values(p.digitalNumbers), ...Object.values(p.analogNumbers)]) expect(names.has(n), `${p.id}:${n}`).toBe(true);
      for (const v of Object.values(p.analogNumbers)) expect(p.pins.find(x => x.name === v)!.adc).toBeDefined();
      expect(p.sources.length).toBeGreaterThan(0);
    }
  });

  it('Uno numbers match ArduinoCore-avr', () => {
    const uno = getMcuProfile('uno');
    const pwm = uno.pins.filter(p => p.pwm).map(p => [p.name, +p.pwm!.freqHz.toFixed(3)]);
    expect(pwm).toEqual([['D3', 490.196], ['D5', 976.563], ['D6', 976.563], ['D9', 490.196], ['D10', 490.196], ['D11', 490.196]]);
    expect(uno.pins.filter(p => p.interrupt !== undefined).map(p => [p.name, p.interrupt])).toEqual([['D2', 0], ['D3', 1]]);
    expect(uno.limits).toMatchObject({ pinAbsMaxMa: 40, pinRecommendedMa: 20, vccGndMaxMa: 200 });
    expect(uno.adc).toMatchObject({ bits: 10, defaultReference: 'DEFAULT' });
    expect(uno.vcc).toBe(5);
  });
});

describe('measurement helpers', () => {
  const log = [
    { t: 0, port: 'Serial', text: 'boot' },
    { t: 0.001, port: 'Serial', text: '\r\nready\r\n' },
    { t: 0.5, port: 'Serial', text: 'temp=21.5\r\ntemp=' },
    { t: 1, port: 'Serial', text: '22.0\r\n' },
  ];

  it('serial: contains / matches / line count / first time', () => {
    expect(measure.serialContains(log, 'ready')).toBe(true);
    expect(measure.serialMatches(log, /temp=(\d+\.\d)/)![1]).toBe('21.5');
    expect(measure.serialLineCount(log)).toBe(4);
    expect(measure.serialLines(log).map(l => l.text)).toEqual(['boot', 'ready', 'temp=21.5', 'temp=22.0']);
    expect(measure.serialFirstTime(log, 'ready')).toBe(0.001);
    expect(measure.serialFirstTime(log, 'temp=22')).toBe(1); // completed by the last chunk
    expect(measure.serialFirstTime(log, /temp=2\d/g)).toBe(0.5);
    expect(measure.serialFirstTime(log, 'nope')).toBeUndefined();
  });

  it('pins: toggles, frequency and duty in a window', () => {
    const lv = [0, 1, 2, 3, 4].flatMap(k => [
      { t: k * 0.01, level: 1 as const },
      { t: k * 0.01 + 0.0025, level: 0 as const },
    ]);
    expect(measure.toggleCount(lv)).toBe(10);
    expect(measure.toggleCount(lv, { from: 0.015, to: 0.03 })).toBe(3);
    expect(measure.frequency(lv)).toBeCloseTo(100, 9);
    expect(measure.dutyCycle(lv, { from: 0, to: 0.04 })).toBeCloseTo(0.25, 9);
    expect(measure.pwmStats(lv)).toEqual({ frequency: expect.closeTo(100, 9), duty: expect.closeTo(0.25, 9), periods: 4 });
    expect(measure.levelAt(lv, 0.011)).toBe(1);
    expect(measure.levelAt(lv, -1)).toBe(0);
    expect(measure.highTime(lv, { from: 0.001, to: 0.012 })).toBeCloseTo(0.0015 + 0.002, 12);
  });
});
