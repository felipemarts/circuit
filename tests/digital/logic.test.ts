import { describe, it, expect } from 'vitest';
import {
  DigitalCircuit,
  And,
  Or,
  Nand,
  Nor,
  Xor,
  Xnor,
  Not,
  Buf,
  TriBuf,
  Mux,
  logicAnd,
  logicOr,
  logicXor,
  logicNot,
  logicNand,
  logicNor,
  logicXnor,
  logicBuf,
  resolveLogic,
} from '../../src/digital';
import type { Logic, DigitalPart } from '../../src/digital';

const V: Logic[] = [0, 1, 'X', 'Z'];

/** Settled output of a part whose inputs are external ports with the given initial values. */
function settle(part: DigitalPart, inputs: Record<string, Logic>): Logic {
  const c = new DigitalCircuit();
  const wiring: Record<string, string> = { y: 'Y' };
  for (const pin of Object.keys(inputs)) {
    c.input(`I_${pin}`, { initial: inputs[pin] });
    wiring[pin] = `I_${pin}`;
  }
  c.add('U1', part, wiring);
  return c.build().value('Y');
}

// Expected 4-valued tables, rows a = 0,1,X,Z; cols b = 0,1,X,Z.
const AND: Logic[][] = [
  [0, 0, 0, 0],
  [0, 1, 'X', 'X'],
  [0, 'X', 'X', 'X'],
  [0, 'X', 'X', 'X'],
];
const OR: Logic[][] = [
  [0, 1, 'X', 'X'],
  [1, 1, 1, 1],
  ['X', 1, 'X', 'X'],
  ['X', 1, 'X', 'X'],
];
const XOR: Logic[][] = [
  [0, 1, 'X', 'X'],
  [1, 0, 'X', 'X'],
  ['X', 'X', 'X', 'X'],
  ['X', 'X', 'X', 'X'],
];
const inv = (v: Logic): Logic => (v === 0 ? 1 : v === 1 ? 0 : 'X');

const GATES: [string, (o: object) => DigitalPart, Logic[][], (...v: Logic[]) => Logic][] = [
  ['And', o => new And(o), AND, logicAnd],
  ['Or', o => new Or(o), OR, logicOr],
  ['Xor', o => new Xor(o), XOR, logicXor],
  ['Nand', o => new Nand(o), AND.map(r => r.map(inv)), logicNand],
  ['Nor', o => new Nor(o), OR.map(r => r.map(inv)), logicNor],
  ['Xnor', o => new Xnor(o), XOR.map(r => r.map(inv)), logicXnor],
];

describe('logic operators (pure functions)', () => {
  for (const [name, , table, fn] of GATES) {
    it(`${name}: full 4-valued truth table`, () => {
      V.forEach((a, i) => V.forEach((b, j) => expect(fn(a, b), `${name}(${a},${b})`).toBe(table[i][j])));
    });
  }
  it('Not / Buf map Z to X', () => {
    expect(V.map(logicNot)).toEqual([1, 0, 'X', 'X']);
    expect(V.map(logicBuf)).toEqual([0, 1, 'X', 'X']);
  });
  it('N-input folding: controlling values dominate X', () => {
    expect(logicAnd(1, 1, 1, 0)).toBe(0);
    expect(logicAnd(1, 'X', 0)).toBe(0);
    expect(logicOr(0, 'Z', 1)).toBe(1);
    expect(logicXor(1, 1, 1)).toBe(1);
    expect(logicXor(1, 0, 'X')).toBe('X');
  });
});

describe('gate primitives (simulated truth tables incl. X/Z)', () => {
  for (const [name, make, table] of GATES) {
    it(`${name} 2-input`, () => {
      V.forEach((a, i) =>
        V.forEach((b, j) => expect(settle(make({ delay: 0 }), { a, b }), `${name}(${a},${b})`).toBe(table[i][j])),
      );
    });
  }

  it('3- and 4-input gates', () => {
    for (let m = 0; m < 16; m++) {
      const bits = [0, 1, 2, 3].map(i => ((m >> i) & 1) as 0 | 1);
      const ins = { a: bits[0], b: bits[1], c: bits[2], d: bits[3] };
      expect(settle(new And({ inputs: 4, delay: 0 }), ins)).toBe(bits.every(b => b === 1) ? 1 : 0);
      expect(settle(new Or({ inputs: 4, delay: 0 }), ins)).toBe(bits.some(b => b === 1) ? 1 : 0);
      expect(settle(new Xor({ inputs: 4, delay: 0 }), ins)).toBe((bits.filter(b => b === 1).length % 2) as 0 | 1);
      expect(settle(new Nand({ inputs: 3, delay: 0 }), { a: bits[0], b: bits[1], c: bits[2] })).toBe(
        bits.slice(0, 3).every(b => b === 1) ? 0 : 1,
      );
    }
    expect(settle(new Nor({ inputs: 3, delay: 0 }), { a: 0, b: 'X', c: 1 })).toBe(0);
    expect(settle(new Xnor({ inputs: 3, delay: 0 }), { a: 1, b: 1, c: 'Z' })).toBe('X');
  });

  it('Not and Buf', () => {
    expect(V.map(a => settle(new Not({ delay: 0 }), { a }))).toEqual([1, 0, 'X', 'X']);
    expect(V.map(a => settle(new Buf({ delay: 0 }), { a }))).toEqual([0, 1, 'X', 'X']);
  });

  it('TriBuf: drives when enabled, Z when disabled, X when enable unknown', () => {
    expect(settle(new TriBuf({ delay: 0 }), { a: 1, en: 1 })).toBe(1);
    expect(settle(new TriBuf({ delay: 0 }), { a: 0, en: 1 })).toBe(0);
    expect(settle(new TriBuf({ delay: 0 }), { a: 'Z', en: 1 })).toBe('X');
    expect(settle(new TriBuf({ delay: 0 }), { a: 1, en: 0 })).toBe('Z');
    expect(settle(new TriBuf({ delay: 0 }), { a: 1, en: 'X' })).toBe('X');
    expect(settle(new TriBuf({ delay: 0, activeLow: true }), { a: 1, en: 0 })).toBe(1);
    expect(settle(new TriBuf({ delay: 0, activeLow: true }), { a: 1, en: 1 })).toBe('Z');
  });

  it('Mux 2:1 and 4:1 selection, X select resolves when inputs agree', () => {
    expect(settle(new Mux({ delay: 0 }), { s0: 0, d0: 1, d1: 0 })).toBe(1);
    expect(settle(new Mux({ delay: 0 }), { s0: 1, d0: 1, d1: 0 })).toBe(0);
    expect(settle(new Mux({ delay: 0 }), { s0: 'X', d0: 1, d1: 0 })).toBe('X');
    expect(settle(new Mux({ delay: 0 }), { s0: 'X', d0: 1, d1: 1 })).toBe(1);
    const data = { d0: 0 as Logic, d1: 1 as Logic, d2: 1 as Logic, d3: 0 as Logic };
    const expected = [0, 1, 1, 0];
    for (let s = 0; s < 4; s++) {
      expect(settle(new Mux({ select: 2, delay: 0 }), { s0: (s & 1) as 0 | 1, s1: ((s >> 1) & 1) as 0 | 1, ...data })).toBe(expected[s]);
    }
    // s1 = 1 known, s0 = X → candidates d2, d3 = 1, 0 → X; with d3 = 1 → 1.
    expect(settle(new Mux({ select: 2, delay: 0 }), { s0: 'X', s1: 1, ...data })).toBe('X');
    expect(settle(new Mux({ select: 2, delay: 0 }), { s0: 'X', s1: 1, ...data, d3: 1 })).toBe(1);
  });
});

describe('multi-driver resolution', () => {
  it('strength rules', () => {
    expect(resolveLogic([])).toEqual({ value: 'Z', contention: 'none' });
    expect(resolveLogic([{ value: 'Z' }, { value: 1 }])).toEqual({ value: 1, contention: 'none' });
    expect(resolveLogic([{ value: 1 }, { value: 1 }])).toEqual({ value: 1, contention: 'none' });
    expect(resolveLogic([{ value: 0 }, { value: 1 }])).toEqual({ value: 'X', contention: 'strong' });
    expect(resolveLogic([{ value: 'X' }, { value: 1 }])).toEqual({ value: 'X', contention: 'none' });
    expect(resolveLogic([{ value: 1, strength: 'weak' }, { value: 0 }])).toEqual({ value: 0, contention: 'none' });
    expect(resolveLogic([{ value: 1, strength: 'weak' }, { value: 'Z' }])).toEqual({ value: 1, contention: 'none' });
    expect(resolveLogic([{ value: 1, strength: 'weak' }, { value: 0, strength: 'weak' }])).toEqual({ value: 'X', contention: 'weak' });
  });
});
