/**
 * Catalog entries (circuitsvibe catalog) for the simulatable logic ICs, the NE555
 * and the generic logic primitives — generated from the same data the
 * simulation uses, so the catalog never disagrees with the model.
 */
import { findPart } from '../parts';
import { PART_DEFS } from '../digital/parts';
import { findIcDef, icIds } from './ics';
import { FAMILY_REFERENCE_PART, NE555_DELAY, RAMP_FRACTION, UNPOWERED_FRACTION, logicFamilyModel, ne555Model } from './families';
import { CLAMP_IS } from './device';

export interface MixedCatalogEntry {
  type: string;
  example: string;
  pins: string;
  value: string;
  dc: string;
  /** Datasheet-derived model data per supply, citations and model assumptions. */
  details?: string[];
}

const r3 = (x: number): string => String(Number(x.toPrecision(3)));
const ns = (s: number): string => `${r3(s * 1e9)} ns`;

/** tpd paths printed for each IC (path substring as in the catalog record). */
const PATHS: Record<string, string[]> = {
  '74HC00': ['A/B->Y'],
  '74HC04': ['A->Y'],
  '74HC14': ['A->Y'],
  '74HCT04': ['A->Y'],
  '74HC74': ['CLK->Q/~Q', '~PRE/~CLR->Q/~Q'],
  '74HC595': ["SRCLK->QH'", 'RCLK->QA..QH'],
  CD4017: ['CLOCK->decoded out', 'CLOCK->CARRY OUT'],
  CD4011: ['input->output'],
};

function icEntry(id: string): MixedCatalogEntry {
  const def = findIcDef(id)!;
  const part = findPart(id)!;
  const pins = def.pins.map(p => `${p.number}=${p.name}${p.role === 'in' ? (p.bridge === 'schmitt' ? ' (in, Schmitt)' : ' (in)') : p.role === 'out' ? (p.bridge === 'tristate' ? ' (out, 3-state)' : p.bridge === 'disch555' ? ' (open collector)' : ' (out)') : p.role === 'analog' ? ' (analog)' : ' (supply)'}`).join(', ');
  const src = part.sources.map(c => `${c.publisher} ${c.document ?? ''} "${c.title}" ${c.revision ?? ''} ${c.url}`.replace(/\s+/g, ' ').trim());
  const details: string[] = [];
  if (def.kind === 'logic') {
    const f = logicFamilyModel(id);
    const vccs = id === '74HCT04' ? [4.5, 5, 5.5] : f.family === 'CD4000' ? [5, 10, 15] : [2, 3.3, 5, 6];
    details.push(`family ${f.family}; supply ${f.vccMin}–${f.vccMax} V recommended, ${f.vccAbsMax} V absolute max; unpowered below ${r3(UNPOWERED_FRACTION * f.vccMin)} V (outputs high-Z)`);
    for (const v of vccs) {
      const levels = def.pins.some(p => p.bridge === 'schmitt') && f.vtPlus ? `VT+ ${r3(f.vtPlus(v))} V, VT− ${r3(f.vtMinus!(v))} V` : `VIL ${r3(f.vil(v))} V, VIH ${r3(f.vih(v))} V`;
      const t = (PATHS[id] ?? []).map(path => `tpd(${path}) ${ns(f.tpd(path, v, 'typ'))} typ / ${ns(f.tpd(path, v, 'worst'))} max`).join(', ');
      const tr = f.maxInputTransition(v);
      details.push(`VCC ${v} V: ${levels}; Rout high ${r3(f.rOutHigh(v, 'typ'))} Ω, low ${r3(f.rOutLow(v, 'typ'))} Ω (typ); ${t}${tr !== undefined ? `; max input transition ${ns(tr)}` : ''}`);
    }
    if (f.outputCurrentMax !== undefined) details.push(`output current abs max ${r3(f.outputCurrentMax * 1e3)} mA per pin (D511); input clamp |IIK| max ${r3((f.inputClampCurrentMax ?? 0) * 1e3)} mA (D513)`);
    else if (f.outputPowerMax !== undefined) details.push(`output dissipation limit ${r3(f.outputPowerMax * 1e3)} mW per output transistor (D511)`);
    if (id === '74HC74') details.push('timing check: tsu(D) 20 ns, th 0 (datasheet, 4.5 V) → D502/D503');
  } else {
    const t = ne555Model();
    details.push(`supply ${t.vccMin}–${t.vccMax} V recommended, ${t.vccAbsMax} V absolute max; CONT = internal 5k/5k/5k divider (2/3 VCC), trigger level CONT/2, RESET threshold ${t.resetThreshold} V`);
    details.push(`output: high = VCC − ${r3(t.vDropHigh)} V − ${r3(t.rOutHigh)} Ω·I, low Rout ${r3(t.rOutLow(5, 'typ'))} Ω @5 V / ${r3(t.rOutLow(15, 'typ'))} Ω @15 V; discharge Ron ${r3(t.rDischarge(5, 'typ'))} Ω @5 V; |IO| max ${r3(t.outputCurrentMax * 1e3)} mA; edges ${ns(t.ramp)}`);
    details.push(`astable f = 1/(ln2·(R1+2R2)·C) ≈ 1.44/((R1+2R2)C), duty (R1+R2)/(R1+2R2); monostable T = ln3·RC ≈ 1.1RC`);
  }
  details.push(
    `model assumptions (not datasheet values): values between the datasheet supply points are interpolated (Rout in conductance), outside them linearly extrapolated; output ramp ${def.kind === 'timer' ? 'riseTime' : `${RAMP_FRACTION}×tpd`}; tpd de-embedded from the 50 pF test load (ln2·Rout·50pF + ramp/2 subtracted)${def.kind === 'timer' ? `; latch delay ${ns(NE555_DELAY)}` : `; input clamp diodes Is ${CLAMP_IS} A`}`,
  );
  details.push(...src.map(s => `source: ${s}`));
  return {
    type: def.id,
    example: `const u1 = tb.add('U1', Part('${def.id}'))  ·  u1.pin('${def.pins.find(p => p.role === 'in')!.name}') or u1.pin(${def.pins.find(p => p.role === 'in')!.number})  ·  Part('${def.id}', { corner: 'worst'${def.kind === 'logic' ? ', clamp: false' : ''} })`,
    pins,
    value: `${def.summary}. Options: corner 'typ' (default) | 'worst' (max tpd, max Rout)${def.kind === 'logic' ? '; clamp (input protection diodes, default true)' : ''}`,
    dc: `levels referenced to its own VCC/GND pins; outputs = Thevenin stage from the datasheet VOH/VOL rows; probes: logic 'U1.<pin>' / 'U1.pin<N>' (tb.expect.logic), voltage 'U1.<pin>' (op/tran)`,
    details,
  };
}

function primitiveEntry(type: string): MixedCatalogEntry {
  const d = PART_DEFS[type];
  const layout = d.pins(d.normalize(type === 'Clock' ? { freq: 1e6 } : type === 'Const' || type === 'Pull' ? { value: 1 } : type === 'Stimulus' ? { initial: 0 } : {}));
  const ctor =
    type === 'Clock' ? `new Clock({ freq: '1M' })` : type === 'Const' ? `new Const(1)` : type === 'Pull' ? `new Pull(1)` : type === 'Stimulus' ? `new Stimulus({ pattern: '0110', step: '1u' })` : `new ${type}()`;
  return {
    type,
    example: `tb.add('G1', ${ctor})`,
    pins: [...layout.inputs.map(p => `'${p}'`), ...layout.outputs.map(p => `'${p}' (out)`)].join(', '),
    value: `${d.summary}. Options as in src/digital (delay default 1 ns) + family: 'HC' | 'HCT' | 'CD4000' (default 'HC'), vcc (default 5)`,
    dc:
      type === 'Pull'
        ? 'pure-digital nets only (on an analog net use a resistor)'
        : `pure-digital nets: event engine only; a pin on an analog net is bridged with the family levels (${Object.entries(FAMILY_REFERENCE_PART).map(([f, p]) => `${f} = ${p} data`).join(', ')}) at the ideal vcc, ground = tb.gnd`,
  };
}

export function mixedCatalog(): MixedCatalogEntry[] {
  // Behavioral is the VHDL back end's process host, not a bench primitive.
  const primitives = Object.keys(PART_DEFS).filter(type => type !== 'Behavioral');
  return [...icIds().map(icEntry), ...primitives.map(primitiveEntry)];
}

export const MIXED_GRAMMAR_NOTES = `REAL PARTS        Part('74HC00' | '74HC04' | '74HC14' | '74HC74' | '74HC595' | '74HCT04' | 'CD4017' | 'CD4011' | 'NE555')
                     pins by datasheet name or number: u1.pin('1A') · u1.pin(1) · u1.pin('~OE') · u1.pin('CARRY OUT')
                     VCC/GND (VDD/VSS) pins MUST be wired (F135); unused inputs tied to a rail (F137)
LOGIC PRIMITIVES  And Or Nand Nor Xor Xnor Not Buf TriBuf Mux DFF JKFF DLatch Counter ShiftRegister Clock Stimulus Const Pull
                     options { delay, ..., family: 'HC'|'HCT'|'CD4000', vcc: 5 }; pins as in src/digital ('a','b','y','clk','q',...)
LOGIC PROBES      '<net>' (tb.name) · '<id>.<pin>' (IC: '1Y', '~1Q', 'pin6'; primitive: 'q')
LOGIC ASSERTIONS  tb.expect.logic(probe, { tstop, ... }?)      (window: given, else the last tb.expect.tran/logic one)
                     .toBe(1).at('2m')  .toToggle({ count | min | max, edge?: 'rising'|'falling'|'both', within?: [from, to] })
                     .toHaveFrequency(f, tol /* fraction */, { from?, to? })  .toHaveDutyCycle(d, tol /* absolute */, { from?, to? })
                     .toBeStable(from, to, { value? })          also tb.expect.tran({...}).logic(probe)
                     analog probes on IC pins: tb.expect.tran({...}).probe('U1.1Y') (pin voltage)
RUN RECORD        stages.tran.logic[]: { config, tEnd, signals: { <name>: [[t, value], ...] } } — probed + named logic nets
                     circuitsvibe verify x.bench.ts --vcd out.vcd   (VCD of that capture)`;
