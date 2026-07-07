import { describe, it, expect } from 'vitest';
import { parseValue, formatEng } from '../../src/core/units';

describe('parseValue', () => {
  it('parses plain numbers and numeric strings', () => {
    expect(parseValue(330)).toBe(330);
    expect(parseValue('330')).toBe(330);
    expect(parseValue('1e-6')).toBe(1e-6);
    expect(parseValue('-2.5')).toBe(-2.5);
  });

  it('parses engineering suffixes case-sensitively', () => {
    expect(parseValue('4.7k')).toBeCloseTo(4700);
    expect(parseValue('10m')).toBeCloseTo(0.01);
    expect(parseValue('10M')).toBeCloseTo(10e6);
    expect(parseValue('2u')).toBeCloseTo(2e-6);
    expect(parseValue('100n')).toBeCloseTo(1e-7);
    expect(parseValue('5p')).toBeCloseTo(5e-12);
    expect(parseValue('1G')).toBeCloseTo(1e9);
  });

  it('accepts and ignores a trailing unit', () => {
    expect(parseValue('10mA')).toBeCloseTo(0.01);
    expect(parseValue('5V')).toBe(5);
    expect(parseValue('2ms')).toBeCloseTo(0.002);
    expect(parseValue('4.7kOhm')).toBeCloseTo(4700);
  });

  it('rejects garbage, NaN and Infinity with actionable messages', () => {
    expect(() => parseValue('abc')).toThrow(/expected a number/);
    expect(() => parseValue(NaN)).toThrow(/finite/);
    expect(() => parseValue(Infinity)).toThrow(/finite/);
    expect(() => parseValue('10x')).toThrow(/expected a number/);
    expect(() => parseValue('', 'resistance')).toThrow(/resistance/);
  });
});

describe('formatEng', () => {
  it('formats with engineering suffixes', () => {
    expect(formatEng(4700)).toBe('4.7k');
    expect(formatEng(0.01364)).toBe('13.64m');
    expect(formatEng(0)).toBe('0');
    expect(formatEng(2.26, 'V')).toBe('2.26V');
    expect(formatEng(1e-6)).toBe('1u');
  });
});
