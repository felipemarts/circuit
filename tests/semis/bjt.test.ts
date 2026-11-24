import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  Circuit,
  VoltageSource,
  CurrentSource,
  Resistor,
  Capacitor,
  NPN,
  PNP,
  describeComponent,
  buildComponent,
} from '../../src/forge';
import { op, type Q } from './helpers';

const VT = 0.02585;
const rel = (a: number, b: number) => Math.abs(a / b - 1);

/** Vbe and Vce forced by ideal sources (emitter grounded); returns the transistor. */
function forced(q: Q, vbe: number, vce: number): Q {
  const c = new Circuit();
  const vb = new VoltageSource(vbe);
  const vc = new VoltageSource(vce);
  vb.pin('+').connect(q.pin('b'));
  vc.pin('+').connect(q.pin('c'));
  q.pin('e').connect(c.ground);
  vb.pin('-').connect(c.ground);
  vc.pin('-').connect(c.ground);
  op(c);
  return q;
}

describe('BJT — Ebers-Moll limit (only Is, Bf, Br)', () => {
  it('forward active: Ic = Is·(e^(Vbe/Vt) − 1) − Is·(e^(Vbc/Vt) − 1)·(1 + 1/Br), Ib = cbe/Bf + cbc/Br (1e-9)', () => {
    const Is = 1e-14;
    for (const vbe of [0.55, 0.65, 0.7]) {
      const q = forced(new NPN({ is: Is, bf: 150, br: 2 }) as unknown as Q, vbe, 5);
      const cbe = Is * (Math.exp(vbe / VT) - 1);
      const cbc = Is * (Math.exp((vbe - 5) / VT) - 1);
      expect(rel(q.quantity('ic'), cbe - cbc * (1 + 1 / 2))).toBeLessThan(1e-9);
      expect(rel(q.quantity('ib'), cbe / 150 + cbc / 2)).toBeLessThan(1e-9);
      expect(rel(q.quantity('ic') / q.quantity('ib'), 150)).toBeLessThan(1e-6); // β = Bf (up to the Is-level reverse terms)
      expect(q.quantity('ie')).toBeCloseTo(-(q.quantity('ic') + q.quantity('ib')), 15);
      expect(q.quantity('vce')).toBe(5);
    }
  });

  it('saturation: Vce(sat) = Vt·ln(x/y) of the Ebers-Moll equations with forced β = 10 (1e-6)', () => {
    const Is = 1e-14;
    const Bf = 100;
    const Br = 1;
    const ib = 1e-3;
    const ic = 10e-3;
    const c = new Circuit();
    const q = new NPN({ is: Is, bf: Bf, br: Br }) as unknown as Q;
    const sb = new CurrentSource(ib);
    const sc = new CurrentSource(ic);
    sb.pin('+').connect(q.pin('b'));
    sc.pin('+').connect(q.pin('c'));
    q.pin('e').connect(c.ground);
    sb.pin('-').connect(c.ground);
    sc.pin('-').connect(c.ground);
    op(c);
    // ic = x − y(1 + 1/Br), ib = x/Bf + y/Br with x = Is·e^(vbe/Vt), y = Is·e^(vbc/Vt)
    const y = (Bf * ib - ic) / (1 + (Bf + 1) / Br);
    const x = Bf * (ib - y / Br);
    const vceSat = VT * Math.log(x / y);
    expect(rel(q.quantity('vce'), vceSat)).toBeLessThan(1e-6);
    expect(q.quantity('vce')).toBeGreaterThan(0.02);
    expect(q.quantity('vce')).toBeLessThan(0.15);
  });
});

describe('BJT — Gummel-Poon effects', () => {
  it('Early effect: dIc/dVce = Is·e^(Vbe/Vt)/Vaf (1e-6)', () => {
    const Is = 1e-14;
    const vbe = 0.65;
    const a = forced(new NPN({ is: Is, bf: 100, vaf: 50 }) as unknown as Q, vbe, 5).quantity('ic');
    const b = forced(new NPN({ is: Is, bf: 100, vaf: 50 }) as unknown as Q, vbe, 10).quantity('ic');
    expect(rel((b - a) / 5, (Is * (Math.exp(vbe / VT) - 1)) / 50)).toBeLessThan(1e-6);
    // …which is the textbook ro = (Vaf + Vce)/Ic, here ≈ Ic/Vaf to within Vbe/Vaf
    expect(rel((b - a) / 5, a / 50)).toBeLessThan(0.1);
  });

  it('high injection (Ikf): Ic = cbe/qb, qb = (1 + √(1 + 4·cbe/Ikf))/2, β rolls off as Bf/qb (1e-9)', () => {
    const Is = 1e-14;
    const Ikf = 0.01;
    for (const vbe of [0.6, 0.75, 0.85]) {
      const q = forced(new NPN({ is: Is, bf: 100, ikf: Ikf }) as unknown as Q, vbe, 5);
      const cbe = Is * (Math.exp(vbe / VT) - 1);
      const qb = (1 + Math.sqrt(1 + (4 * cbe) / Ikf)) / 2;
      expect(rel(q.quantity('ic'), cbe / qb)).toBeLessThan(1e-9);
      expect(rel(q.quantity('ic') / q.quantity('ib'), 100 / qb)).toBeLessThan(1e-6);
    }
    // well above the knee Ic ≈ √(Is·Ikf)·e^(Vbe/2Vt)
    const q = forced(new NPN({ is: Is, bf: 100, ikf: Ikf }) as unknown as Q, 0.95, 5);
    expect(rel(q.quantity('ic'), Math.sqrt(Is * Ikf) * Math.exp(0.95 / (2 * VT)))).toBeLessThan(0.01);
  });

  it('PNP is the exact mirror of the NPN (every voltage and current negated, 1e-12)', () => {
    const params = { is: 2e-14, bf: 120, vaf: 60, ikf: 0.05, ise: 1e-14, ne: 1.6, rb: 10, re: 0.5, rc: 2 };
    const n = forced(new NPN(params) as unknown as Q, 0.68, 4);
    const p = forced(new PNP(params) as unknown as Q, -0.68, -4);
    for (const k of ['ic', 'ib', 'ie', 'vbe', 'vce', 'vbc']) {
      expect(Math.abs(p.quantity(k) + n.quantity(k))).toBeLessThan(1e-12 * Math.abs(n.quantity(k)) + 1e-15);
    }
    expect(rel(p.quantity('p'), n.quantity('p'))).toBeLessThan(1e-12);
  });

  it('Rb/Re/Rc are internal nodes; terminal currents still satisfy KCL', () => {
    const q = new NPN({ rb: 100, re: 1, rc: 10 });
    expect(q.getInternalNodeCount()).toBe(3);
    const f = forced(q as unknown as Q, 0.75, 3);
    expect(Math.abs(f.quantity('ic') + f.quantity('ib') + f.quantity('ie'))).toBeLessThan(1e-12);
  });
});

describe('BJT — common-emitter amplifier', () => {
  const ce = bench('ce', (tb) => {
    const vcc = tb.add('VCC', new VoltageSource(12));
    const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
    const cin = tb.add('CIN', new Capacitor('10u'));
    const r1 = tb.add('R1', new Resistor('47k'));
    const r2 = tb.add('R2', new Resistor('10k'));
    const rc = tb.add('RC', new Resistor('4.7k'));
    const re = tb.add('RE', new Resistor('1k'));
    const ceb = tb.add('CE', new Capacitor('10m'));
    const q1 = tb.add('Q1', new NPN({ is: 1e-14, bf: 200, vaf: 100 }));
    vcc.pin('-').connect(tb.gnd);
    vin.pin('-').connect(tb.gnd);
    vin.pin('+').connect(cin.pin('1'));
    cin.pin('2').connect(q1.pin('b'));
    r1.pin('1').connect(vcc.pin('+'));
    r1.pin('2').connect(q1.pin('b'));
    r2.pin('1').connect(q1.pin('b'));
    r2.pin('2').connect(tb.gnd);
    rc.pin('1').connect(vcc.pin('+'));
    rc.pin('2').connect(q1.pin('c'));
    re.pin('1').connect(q1.pin('e'));
    re.pin('2').connect(tb.gnd);
    ceb.pin('1').connect(q1.pin('e'));
    ceb.pin('2').connect(tb.gnd);
    tb.name('out', q1.pin('c'));
    tb.expect.op('Q1.ic').toBeAbove(0);
    tb.expect.op('Q1.vce').toBeAbove(0);
    tb.expect.ac({ from: '100', to: '10k', pointsPerDecade: 5 }).probe('out').gainAt('1k').toBeAbove(0);
  });

  it('DC bias within 3 % of the hand calculation (Thevenin divider, Vbe = 0.65 V)', () => {
    const r = runLadder(ce, { hints: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.exitCode).toBe(0);
    const ic = r.stages.op!.probes!['Q1.ic'];
    const vth = (12 * 10) / 57;
    const rth = (47e3 * 10e3) / 57e3;
    const ie = (vth - 0.65) / (1e3 + rth / 201);
    const icHand = (ie * 200) / 201;
    expect(rel(ic, icHand)).toBeLessThan(0.03);
    const vce = r.stages.op!.probes!['Q1.vce'];
    expect(rel(vce, 12 - icHand * 4.7e3 - ie * 1e3)).toBeLessThan(0.03);
  });

  it('AC gain at 1 kHz = −gm·(Rc ‖ ro) within 1 % (gm = Ic/Vt, ro = (Vaf + Vce)/Ic)', () => {
    const r = runLadder(ce, { hints: false });
    const ic = r.stages.op!.probes!['Q1.ic'];
    const vce = r.stages.op!.probes!['Q1.vce'];
    const gm = ic / VT;
    const ro = (100 + vce) / ic;
    const expected = gm * ((4.7e3 * ro) / (4.7e3 + ro));
    const gainDb = r.stages.ac!.assertions![0].measured!;
    expect(rel(Math.pow(10, gainDb / 20), expected)).toBeLessThan(0.01);
  });
});

describe('BJT — charges and transient', () => {
  it('junction/transit charges slow a saturated switch down; without them it follows the edge', () => {
    const run = (params: Record<string, number>) => {
      const c = new Circuit();
      const vcc = new VoltageSource(5);
      const vin = new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1u', tr: '1n', tf: '1n', pw: '1' } });
      const rb = new Resistor('4.7k');
      const rc = new Resistor('1k');
      const q = new NPN(params) as unknown as Q;
      vin.pin('+').connect(rb.pin('1'));
      rb.pin('2').connect(q.pin('b'));
      vcc.pin('+').connect(rc.pin('1'));
      rc.pin('2').connect(q.pin('c'));
      q.pin('e').connect(c.ground);
      vin.pin('-').connect(c.ground);
      vcc.pin('-').connect(c.ground);
      const res = c.analyze('transient', { timeStep: 1e-9, maxStep: 2e-8, duration: 3e-6, adaptive: true, ic: 'op' }, [
        { label: 'vce', color: '', component: q, type: 'voltage', quantity: 'vce' },
      ]);
      const t = res.timePoints;
      const v = res.probes[0].values;
      const k = v.findIndex((x, i) => t[i] > 1e-6 && x < 2.5);
      return t[k] - 1e-6;
    };
    const fast = run({ is: 1e-14, bf: 100 });
    const slow = run({ is: 1e-14, bf: 100, cje: 10e-12, cjc: 5e-12, tf: 1e-9, tr: 50e-9 });
    expect(fast).toBeLessThan(20e-9);
    expect(slow).toBeGreaterThan(2 * fast);
    expect(slow).toBeLessThan(1e-6);
  });
});

describe('BJT — params, .model, round trip', () => {
  it('names are case-insensitive; unknown params throw; describe lists non-defaults only', () => {
    const q = new NPN({ BF: 100, Is: '1e-14', VAF: 0 });
    expect(q.params.Bf).toBe(100);
    expect(q.params.Vaf).toBe(Infinity);
    expect(() => new NPN({ beta: 100 })).toThrow(/unknown parameter 'beta'/);
    expect(describeComponent(new NPN({ bf: 150 })).params).toEqual({ Bf: 150 });
    const card = '.MODEL Q2N3904 NPN (Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m\n+ Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75\n+ Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)';
    const m = NPN.fromModel(card);
    expect(m.params.Bf).toBe(416.4);
    expect(m.params.Ikf).toBeCloseTo(0.06678, 15);
    expect(m.params.Tr).toBeCloseTo(239.5e-9, 20);
    expect(m.modelDiagnostics.map(d => d.code)).toEqual(['T008']); // Itf/Vtf/Xtf are not modeled
    for (const dev of [new NPN({ bf: 80, vaf: 40, rb: 5 }), new PNP({ bf: 60, cje: 1e-12 }), m]) {
      const info = describeComponent(dev);
      expect(describeComponent(buildComponent(info.type, JSON.parse(JSON.stringify(info.params))))).toEqual(info);
    }
  });
});
