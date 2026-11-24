import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bench, runLadder, VoltageSource, Resistor, Capacitor, LED, Part, Not, Clock, Const, TriBuf, findDiagnosticDoc } from '../../src/forge';
import type { LogicIC } from '../../src/mixed/device';
import { MIXED_CODES } from '../../src/mixed/diagnostics';
import { power, tieLow } from './helpers';

const codes = (r: ReturnType<typeof runLadder>) => r.diagnostics.map(d => `${d.code}:${d.severity}`);

describe('bench-level digital lint', () => {
  it('F136: two push-pull outputs tied; F138: output tied to ground', () => {
    const r = runLadder(
      bench('tied', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        const v = power(tb, u, 5);
        u.pin('1A').connect(tb.gnd);
        u.pin('2A').connect(v);
        u.pin('1Y').connect(u.pin('2Y'));
        u.pin('3Y').connect(tb.gnd);
        tieLow(tb, u, ['3A', '4A', '5A', '6A']);
      }),
    );
    expect(r.exitCode).toBe(2);
    const f136 = r.diagnostics.find(d => d.code === 'F136')!;
    expect(f136.subject?.pins).toEqual(['U1.1Y', 'U1.2Y']);
    const f138 = r.diagnostics.find(d => d.code === 'F138')!;
    expect(f138.subject?.pins).toEqual(['U1.3Y']);
    expect(r.stages.op?.verdict).toBe('skipped');
  });

  it('F137: a used input floating is an error; inputs of an unused gate are a warning; no F106 noise for IC pins', () => {
    const r = runLadder(
      bench('float', tb => {
        const u = tb.add('U1', Part('74HC00')) as LogicIC;
        power(tb, u, 5);
        const c = tb.add('C1', new Capacitor('1n'));
        u.pin('1A').connect(c.pin('1'));
        c.pin('2').connect(tb.gnd);
        u.pin('1B').connect(tb.gnd);
        const r1 = tb.add('R1', new Resistor('1k'));
        u.pin('1Y').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        tieLow(tb, u, ['2A', '2B', '3A', '3B']); // gate 4 left completely open
      }),
    );
    expect(codes(r).sort()).toEqual(['F137:error', 'F137:warning']);
    const [err, warn] = [r.diagnostics.find(d => d.severity === 'error')!, r.diagnostics.find(d => d.severity === 'warning')!];
    expect(err.subject?.pins).toEqual(['U1.1A']);
    expect(warn.subject?.pins).toEqual(['U1.4A', 'U1.4B']);
  });

  it('a pure-digital island with a floating input is reported by the digital lint (F130), not as F101/F103', () => {
    const r = runLadder(
      bench('island', tb => {
        const v = tb.add('V1', new VoltageSource(1));
        const r1 = tb.add('R1', new Resistor('1k'));
        v.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        v.pin('-').connect(tb.gnd);
        const a = tb.add('G1', new Not());
        const b = tb.add('G2', new Not());
        a.pin('y').connect(b.pin('a'));
      }),
    );
    expect(codes(r)).toEqual(['F130:error']);
  });
});

describe('mixed-signal runtime diagnostics', () => {
  it('D511: an LED straight on a 74HC04 output exceeds the 25 mA absolute maximum', () => {
    const r = runLadder(
      bench('led-direct', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        power(tb, u, 5);
        const d1 = tb.add('D1', new LED());
        tieLow(tb, u, ['1A', '2A', '3A', '4A', '5A', '6A']);
        u.pin('1Y').connect(d1.pin('anode'));
        d1.pin('cathode').connect(tb.gnd);
      }),
    );
    expect(r.exitCode).toBe(2);
    const d = r.diagnostics.find(x => x.code === 'D511')!;
    expect(d.stage).toBe('op');
    expect((d.evidence as { current: number }).current).toBeGreaterThan(0.025);
    expect(d.at).toMatch(/lint-runtime\.test\.ts/);
  });

  it('D511 names both drivers when two enabled tri-state outputs fight on one analog net (transient)', () => {
    const r = runLadder(
      bench('fight', tb => {
        const hi = tb.add('HI', new Const(1));
        const lo = tb.add('LO', new Const(0));
        const en = tb.add('EN', new Clock({ period: '2u', start: '1u' })); // low, then high from 1 µs
        const t1 = tb.add('T1', new TriBuf());
        const t2 = tb.add('T2', new TriBuf());
        const r1 = tb.add('R1', new Resistor('10k'));
        hi.pin('y').connect(t1.pin('a'));
        lo.pin('y').connect(t2.pin('a'));
        en.pin('y').connect(t1.pin('en'));
        t2.pin('en').connect(t1.pin('en'));
        t1.pin('y').connect(t2.pin('y'));
        t1.pin('y').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        tb.name('bus', r1.pin('1'));
        tb.expect.tran({ tstop: '1.5u' }).probe('bus').toNeverExceed(6);
      }),
      { stages: ['lint', 'tran'] },
    );
    expect(r.exitCode).toBe(2);
    const d = r.diagnostics.find(x => x.code === 'D511')!;
    expect(d.message).toMatch(/contention through the analog net/);
    expect(d.subject?.components).toEqual(['T1', 'T2']);
    expect((d as { time?: number }).time).toBeGreaterThanOrEqual(1e-6);
  });

  it('D513: an input driven 2 V above VCC through a small resistor overloads its clamp diode', () => {
    const r = runLadder(
      bench('clamp', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        power(tb, u, 3.3);
        const v = tb.add('V5', new VoltageSource(5.5));
        const r1 = tb.add('R1', new Resistor('47'));
        v.pin('-').connect(tb.gnd);
        v.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(u.pin('1A'));
        tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      }),
    );
    expect(codes(r)).toContain('D513:error');
  });

  it('D514: an RC oscillator has no DC logic state (warning, op still reported)', () => {
    const r = runLadder(
      bench('osc-op', tb => {
        const u = tb.add('U1', Part('74HC14')) as LogicIC;
        power(tb, u, 5);
        const r1 = tb.add('R1', new Resistor('10k'));
        const c1 = tb.add('C1', new Capacitor('10n'));
        u.pin('1Y').connect(r1.pin('1'));
        r1.pin('2').connect(u.pin('1A'));
        c1.pin('1').connect(u.pin('1A'));
        c1.pin('2').connect(tb.gnd);
        tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(codes(r)).toEqual(['D514:warning']);
  });

  it('D512: an X driven onto an analog net (bridged primitive with an X input)', () => {
    const r = runLadder(
      bench('xout', tb => {
        const clk = tb.add('CLK', new Clock({ freq: '1M' }));
        const g = tb.add('G1', new Not());
        const r1 = tb.add('R1', new Resistor('10k'));
        clk.pin('y').connect(g.pin('a'));
        g.pin('y').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        const x = tb.add('GX', new Not());
        const r2 = tb.add('R2', new Resistor('10k'));
        const src = tb.add('SX', new Const('X'));
        src.pin('y').connect(x.pin('a'));
        x.pin('y').connect(r2.pin('1'));
        r2.pin('2').connect(tb.gnd);
      }),
    );
    expect(codes(r)).toEqual(['D512:warning']);
  });
});

describe('code registry', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '../../docs/DIAGNOSTICS.md'), 'utf8');
  for (const info of Object.values(MIXED_CODES)) {
    it(`${info.code} (${info.slug}) is registered and documented`, () => {
      expect(info.code).toMatch(/^(D5(0[89]|[1-4]\d)|F13[5-9])$/);
      const doc = findDiagnosticDoc(info.code)!;
      expect(doc.slug).toBe(info.slug);
      expect(doc.explanation.length).toBeGreaterThan(80);
      expect(md).toContain(`| \`${info.code}\` | ${info.slug} |`);
    });
  }
});
