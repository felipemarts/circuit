import { describe, it, expect } from 'vitest';
import { bench, elaborate, runLint, runLadder, VoltageSource, Resistor, Capacitor, CurrentSource, NPN, PNP, NMOS, PMOS, Part } from '../../src/forge';
import type { TB } from '../../src/forge';

const lintOf = (build: (tb: TB) => void) => runLint(elaborate(bench('t', build)));
const codes = (build: (tb: TB) => void) => lintOf(build).map(d => d.code);

describe('F108 — MOSFET gate without a DC path', () => {
  const gateVia = (rg: boolean) => (tb: TB) => {
    const vdd = tb.add('VDD', new VoltageSource(10));
    const vin = tb.add('VIN', new VoltageSource({ dc: 0, sin: { offset: 0, amplitude: 1, freq: '1k' } }));
    const c1 = tb.add('C1', new Capacitor('100n'));
    const rd = tb.add('RD', new Resistor('1k'));
    const m = tb.add('M1', new NMOS({ vto: 2, kp: '10m' }));
    vin.pin('+').connect(c1.pin('1'));
    c1.pin('2').connect(m.pin('g'));
    vdd.pin('+').connect(rd.pin('1'));
    rd.pin('2').connect(m.pin('d'));
    m.pin('s').connect(tb.gnd);
    vdd.pin('-').connect(tb.gnd);
    vin.pin('-').connect(tb.gnd);
    if (rg) {
      const r = tb.add('RG', new Resistor('100k'));
      r.pin('1').connect(m.pin('g'));
      r.pin('2').connect(tb.gnd);
    }
  };

  it('gate driven only through a capacitor → F108 (error), replacing F101', () => {
    const d = lintOf(gateVia(false));
    expect(d.map(x => x.code)).toEqual(['F108']);
    expect(d[0]).toMatchObject({ severity: 'error', subject: { components: ['M1'] } });
    expect(d[0].message).toMatch(/driven only through a capacitor/);
    expect(runLadder(bench('t', gateVia(false))).exitCode).toBe(2);
  });

  it('a gate pull-down fixes it; an open gate pin is F108 too', () => {
    expect(codes(gateVia(true))).toEqual([]);
    expect(
      codes(tb => {
        const v = tb.add('V1', new VoltageSource(5));
        const r = tb.add('R1', new Resistor('1k'));
        const m = tb.add('M1', new NMOS({ vto: 1 }));
        v.pin('+').connect(r.pin('1'));
        r.pin('2').connect(m.pin('d'));
        m.pin('s').connect(tb.gnd);
        v.pin('-').connect(tb.gnd);
        m.pin('g'); // never connected
      }),
    ).toEqual(['F108', 'F106']);
  });
});

describe('F109 — BJT junction clamped by an ideal source', () => {
  const driven = (rb: boolean) => (tb: TB) => {
    const vcc = tb.add('VCC', new VoltageSource(12));
    const vb = tb.add('VB', new VoltageSource(5));
    const rc = tb.add('RC', new Resistor('1k'));
    const q = tb.add('Q1', new NPN({ bf: 100 }));
    vcc.pin('+').connect(rc.pin('1'));
    rc.pin('2').connect(q.pin('c'));
    if (rb) {
      const r = tb.add('RB', new Resistor('10k'));
      vb.pin('+').connect(r.pin('1'));
      r.pin('2').connect(q.pin('b'));
    } else {
      vb.pin('+').connect(q.pin('b'));
    }
    q.pin('e').connect(tb.gnd);
    vcc.pin('-').connect(tb.gnd);
    vb.pin('-').connect(tb.gnd);
  };
  it('base straight on a 5 V source → F109 error with the estimate; a base resistor clears it', () => {
    const d = lintOf(driven(false));
    expect(d.map(x => x.code)).toEqual(['F109']);
    expect(d[0].message).toMatch(/Q1 base-emitter junction is forward-clamped at 5 V/);
    expect(codes(driven(true))).toEqual([]);
  });
  it('a sane clamp (0.6 V on the base) and a reverse clamp do not fire', () => {
    const at = (v: number) => (tb: TB) => {
      const vcc = tb.add('VCC', new VoltageSource(12));
      const vb = tb.add('VB', new VoltageSource(v));
      const rc = tb.add('RC', new Resistor('1k'));
      const q = tb.add('Q1', new NPN({ is: 1e-14, bf: 100 }));
      vcc.pin('+').connect(rc.pin('1'));
      rc.pin('2').connect(q.pin('c'));
      vb.pin('+').connect(q.pin('b'));
      q.pin('e').connect(tb.gnd);
      vcc.pin('-').connect(tb.gnd);
      vb.pin('-').connect(tb.gnd);
    };
    expect(codes(at(0.6))).toEqual([]);
    expect(codes(at(-3))).toEqual([]);
  });
});

describe('F107 — BJT base without DC bias (warning)', () => {
  it('AC-coupled base with no bias network → F107; adding a bias resistor or a current source clears it', () => {
    const build = (bias: 'none' | 'resistor' | 'current') => (tb: TB) => {
      const vcc = tb.add('VCC', new VoltageSource(12));
      const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
      const c1 = tb.add('C1', new Capacitor('1u'));
      const rc = tb.add('RC', new Resistor('4.7k'));
      const q = tb.add('Q1', new NPN({ bf: 100 }));
      vin.pin('+').connect(c1.pin('1'));
      c1.pin('2').connect(q.pin('b'));
      vcc.pin('+').connect(rc.pin('1'));
      rc.pin('2').connect(q.pin('c'));
      q.pin('e').connect(tb.gnd);
      vcc.pin('-').connect(tb.gnd);
      vin.pin('-').connect(tb.gnd);
      if (bias === 'resistor') {
        const r = tb.add('RB', new Resistor('470k'));
        r.pin('1').connect(vcc.pin('+'));
        r.pin('2').connect(q.pin('b'));
      } else if (bias === 'current') {
        const i = tb.add('IB', new CurrentSource('10u'));
        i.pin('+').connect(q.pin('b'));
        i.pin('-').connect(tb.gnd);
      }
    };
    const d = lintOf(build('none'));
    expect(d.map(x => [x.code, x.severity])).toEqual([['F107', 'warning']]);
    expect(d[0].message).toMatch(/reached only through a capacitor/);
    expect(codes(build('resistor'))).toEqual([]);
    expect(codes(build('current'))).toEqual([]);
  });
});

describe('F110 — reversed polarity (warning)', () => {
  const lowSide = (dev: 'PMOS' | 'NMOS' | 'PNP' | 'NPN') => (tb: TB) => {
    const vdd = tb.add('VDD', new VoltageSource(5));
    const vg = tb.add('VG', new VoltageSource({ pulse: { v1: 0, v2: 5, tr: '1u', tf: '1u', pw: '1m', per: '2m' } }));
    const rl = tb.add('RL', new Resistor('100'));
    vdd.pin('+').connect(rl.pin('1'));
    vdd.pin('-').connect(tb.gnd);
    vg.pin('-').connect(tb.gnd);
    if (dev === 'PMOS' || dev === 'NMOS') {
      const m = tb.add('M1', dev === 'PMOS' ? new PMOS({ vto: -1.5, kp: '50m' }) : new NMOS({ vto: 1.5, kp: '50m' }));
      rl.pin('2').connect(m.pin('d'));
      vg.pin('+').connect(m.pin('g'));
      m.pin('s').connect(tb.gnd);
    } else {
      const rb = tb.add('RB', new Resistor('1k'));
      const q = tb.add('Q1', dev === 'PNP' ? new PNP({ bf: 100 }) : new NPN({ bf: 100 }));
      rl.pin('2').connect(q.pin('c'));
      vg.pin('+').connect(rb.pin('1'));
      rb.pin('2').connect(q.pin('b'));
      q.pin('e').connect(tb.gnd);
    }
  };
  it('a PMOS / PNP used as a low-side switch (source/emitter on gnd, all sources ≥ 0) → F110', () => {
    expect(codes(lowSide('PMOS'))).toEqual(['F110']);
    expect(codes(lowSide('PNP'))).toEqual(['F110']);
    expect(lintOf(lowSide('PMOS'))[0].message).toMatch(/M1 \(PMOS\) has its source on gnd, the lowest potential/);
  });
  it('the N-type low-side switch is fine; an N-type with its source on the top rail is flagged', () => {
    expect(codes(lowSide('NMOS'))).toEqual([]);
    expect(codes(lowSide('NPN'))).toEqual([]);
    const high = codes(tb => {
      const vdd = tb.add('VDD', new VoltageSource(5));
      const rl = tb.add('RL', new Resistor('100'));
      const rg = tb.add('RG', new Resistor('1k'));
      const m = tb.add('M1', new NMOS({ vto: 1.5 }));
      vdd.pin('-').connect(tb.gnd);
      m.pin('s').connect(vdd.pin('+'));
      m.pin('d').connect(rl.pin('1'));
      rl.pin('2').connect(tb.gnd);
      rg.pin('1').connect(m.pin('g'));
      rg.pin('2').connect(tb.gnd);
    });
    expect(high).toEqual(['F110']);
  });
  it('does not run when the proof does not hold (capacitors can pump a node below ground)', () => {
    expect(
      codes(tb => {
        lowSide('PMOS')(tb);
        const c = tb.add('C1', new Capacitor('1u'));
        c.pin('1').connect(tb.gnd);
        c.pin('2').connect((tb._components.get('RL') as Resistor).pin('2'));
      }),
    ).toEqual([]);
  });
});

describe('Part() devices go through the same lint', () => {
  it('F105 accounts for the diode series resistance: a real LED across 3 V is a rating problem, not a lint error', () => {
    const b = (tb: TB) => {
      const v = tb.add('V1', new VoltageSource(3));
      const d = tb.add('D1', Part('LED-RED-5MM'));
      v.pin('+').connect(d.pin('anode'));
      d.pin('cathode').connect(tb.gnd);
      v.pin('-').connect(tb.gnd);
    };
    expect(codes(b)).toEqual([]);
    const rec = runLadder(bench('t', b), { hints: false });
    expect(rec.exitCode).toBe(1);
    expect(rec.stages.op!.ratings!.some(r => r.verdict === 'fail' && r.code === 'R402')).toBe(true);
  });
});
