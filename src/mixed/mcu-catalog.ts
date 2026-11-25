/**
 * `circuitsvibe catalog` entries for microcontrollers (Mcu + profiles, the
 * ArduinoUno board) and VHDL blocks — generated from the profile, electrical
 * and VHDL data the simulation uses.
 */
import { MCU_PROFILES } from '../mcu/profiles';
import { MCU_ELECTRICAL } from '../mcu/electrical';
import type { McuProfile } from '../mcu/types';
import type { MixedCatalogEntry } from './catalog';

const r3 = (x: number): string => String(Number(x.toPrecision(3)));

const PROFILE_TYPE: Record<string, string> = { atmega328p: 'ATmega328P', attiny85: 'ATtiny85', esp32: 'ESP32', rp2040: 'RP2040' };

function pinList(p: McuProfile): string {
  return p.pins
    .map(s => {
      const caps: string[] = [];
      if (!s.output) caps.push('input only');
      if (s.adc !== undefined) caps.push((s.notes ?? []).map(n => n.match(/^ADC\d_CH\d+/)?.[0]).find(Boolean) ?? `ADC${s.adc}`);
      if (s.pwm) caps.push(`PWM ${r3(s.pwm.freqHz)} Hz`);
      if (s.interrupt !== undefined && p.pins.filter(x => x.interrupt !== undefined).length <= 6) caps.push(`INT${s.interrupt}`);
      return caps.length ? `${s.name} (${caps.join(', ')})` : s.name;
    })
    .join(', ');
}

function profileDetails(p: McuProfile): string[] {
  const e = MCU_ELECTRICAL[p.id];
  const L = p.limits;
  const pwm = p.pins.filter(s => s.pwm);
  const groups = new Map<string, string[]>();
  for (const s of pwm) {
    const key = `${r3(s.pwm!.freqHz)} Hz ${s.pwm!.formula}`;
    groups.set(key, [...(groups.get(key) ?? []), s.name]);
  }
  const irq = p.pins.filter(s => s.interrupt !== undefined);
  const lv = p.logic;
  const out: string[] = [
    `${p.part} on ${p.board} — core ${p.core}, ${r3(p.cpuHz / 1e6)} MHz; supply nominal ${p.vcc} V, recommended ${e.vccRecommended[0]}–${e.vccRecommended[1]} V, absolute max ${e.vccAbsMax} V (M623); reset below ${e.resetBelow} V (M622: ${e.resetSource})`,
    `inputs: VIL ${lv.absolute ? `${lv.vilMax} V` : `${lv.vilMax}·VCC`}, VIH ${lv.absolute ? `${lv.vihMin} V` : `${lv.vihMin}·VCC`} (rising edge at VIH, falling at VIL); internal pull-up ${r3(e.pullup / 1e3)} kΩ${e.pulldown ? `, pull-down ${r3(e.pulldown / 1e3)} kΩ` : ''} (nominal of ${lv.pullupOhms ? `${r3(lv.pullupOhms[0] / 1e3)}–${r3(lv.pullupOhms[1] / 1e3)} kΩ` : 'the datasheet value'})`,
    ...e.drive.map(d => `output drive at VCC ${d.vcc} V: Rout high ${r3(d.rHigh)} Ω, low ${r3(d.rLow)} Ω — from ${d.row}${e.driveEstimated ? ' (ESTIMATED)' : ''}`),
    `ADC: ${p.adc.bits}-bit (analogRead returns ${p.adc.defaultReadBits} bits${p.adc.adjustableResolution ? ', analogReadResolution()' : ''}), code = floor(Vin·2^bits/Vref) clamped; references ${Object.entries(p.adc.references).map(([k, v]) => `${k} = ${v === 'vcc' ? 'VCC (the simulated supply)' : typeof v === 'number' ? `${v} V` : `pin ${v.pin}`}`).join(', ')}; conversion modelled as instantaneous${p.adc.conversionTimeUs ? ` (real: ${r3(p.adc.conversionTimeUs)} µs)` : ''}`,
    `PWM (analogWrite 0..${p.pwmRange}): ${[...groups.entries()].map(([k, pins]) => `${pins.join(' ')} at ${k}`).join('; ') || 'none'}; real edges by default, { pwm: 'average' } for the duty-cycle average`,
    `interrupts (attachInterrupt RISING/FALLING/CHANGE): ${irq.length > 6 ? 'every GPIO (interrupt number = pin number)' : irq.map(s => `${s.name} = ${s.interrupt}`).join(', ')}`,
    `current limits: ${[
      L.pinAbsMaxMa !== undefined ? `per pin ${L.pinAbsMaxMa} mA absolute (R410)` : '',
      L.pinRecommendedMa !== undefined ? `${L.pinRecommendedMa} mA test/recommended (R411 warning)` : '',
      L.vccGndMaxMa !== undefined ? `VCC/GND ${L.vccGndMaxMa} mA (R413)` : '',
      L.totalSinkMaxMa !== undefined ? `Σ sink ${L.totalSinkMaxMa} mA (R413)` : '',
      L.totalSourceMaxMa !== undefined ? `Σ source ${L.totalSourceMaxMa} mA (R413)` : '',
      ...(L.portGroups ?? []).map(g => `${g.sinkMaxMa !== undefined ? `Σ sink ${g.sinkMaxMa}` : `Σ source ${g.sourceMaxMa}`} mA over ${g.pins.join(' ')} (R412)`),
    ]
      .filter(Boolean)
      .join('; ')}`,
    ...(L.notes ?? []).map(n => `limits note: ${n}`),
    ...(p.notes ?? []).map(n => `note: ${n}`),
    `model assumptions (not datasheet values): output edges ramp over ${r3(e.ramp * 1e9)} ns; ESD clamp diodes Is 1e-14 A to VCC/GND; 1 GΩ pin leakage; no core supply current; pins high-Z in reset (operating point, unpowered, after a brown-out)`,
    ...p.sources.map(s => `source: ${s}`),
    ...e.sources.map(s => `source: ${s}`),
  ];
  return out;
}

function profileEntry(p: McuProfile): MixedCatalogEntry {
  const board = p.id === 'atmega328p';
  return {
    type: PROFILE_TYPE[p.id] ?? p.id,
    example: board
      ? `tb.add('U1', new Mcu({ profile: 'atmega328p', firmware: './app.fw.ts' }))  ·  board names: new ArduinoUno({ firmware })`
      : `tb.add('U1', new Mcu({ profile: '${p.id}', firmware: './app.fw.ts' }))`,
    pins: `${pinList(p)}${Object.values(p.adc.references).some(r => typeof r === 'object' && !p.pins.some(s => s.name === r.pin)) ? ', AREF' : ''}, VCC, GND (supply — must be wired, F139)`,
    value: `Mcu profile '${p.id}': firmware (path relative to the bench, a { entry, files } source bundle, or { setup, loop }), pwm 'edges' | 'average', randomSeed`,
    dc: `operating point = reset (pins high-Z); the firmware runs in the transient, in lockstep (firmware time = simulation time); probes: voltage 'U1.<pin>', logic 'U1.<pin>' (driven level while OUTPUT, input-buffer level otherwise), serial tb.expect.serial('U1')`,
    details: profileDetails(p),
  };
}

export function mcuCatalog(): MixedCatalogEntry[] {
  const uno = MCU_PROFILES.atmega328p;
  return [
    {
      type: 'Mcu',
      example: `const u1 = tb.add('U1', new Mcu({ profile: 'atmega328p', firmware: './blink.fw.ts' }))  ·  u1.pin('VCC').connect(v5.pin('+'))  ·  u1.pin('D13')`,
      pins: `the profile's pin names (circuitsvibe catalog ATmega328P | ATtiny85 | ESP32 | RP2040) + VCC, GND (+ AREF on the ATmega328P)`,
      value: `{ profile?: 'atmega328p' (default) | 'attiny85' | 'esp32' | 'rp2040', firmware, pwm?: 'edges' | 'average', randomSeed? }. Firmware: Arduino-style TypeScript — export async function setup()/loop(), import { … } from 'circuitsvibe/arduino', every wait is \`await delay(ms)\``,
      dc: `reset at the operating point; co-simulated with the transient (runLadderAsync / the CLI); lint: F139 supply, F140–F149 firmware, M608 load errors; runtime M601–M623; ratings R410–R413 in stages.tran.ratings; stages.tran.serial[] timestamped lines`,
      details: [
        'pin model: OUTPUT = push-pull Thevenin from the MCU\'s VCC/GND pins (Rout from the datasheet VOH/VOL rows at the simulated supply); INPUT_PULLUP/PULLDOWN = the nominal internal resistor; inputs switch at VIH rising / VIL falling (hysteresis); ADC reads the pin voltage against VCC (or INTERNAL/EXTERNAL)',
        'co-simulation: every firmware wake time (delay expiry, PWM/tone edge, Timer1 tick) is a transient breakpoint; attachInterrupt pins cut the step at their threshold crossing (edge time within 1 ns); the firmware reads the accepted solution at its own time',
        'power: the MCU must be powered at t = 0 (else M622, never starts); a brown-out later latches it in reset (M622); supply outside the recommended range M623',
        'not modelled: instruction timing (code between awaits takes zero time), UART timing, I2C/SPI/EEPROM, sleep modes, core supply current, delayed power-up / restart after brown-out',
      ],
    },
    {
      type: 'ArduinoUno',
      example: `const u1 = tb.add('U1', new ArduinoUno({ firmware: './blink.fw.ts' }))  ·  Part('ArduinoUno', { firmware })  ·  u1.pin('5V').connect(v5.pin('+')); u1.pin('GND').connect(tb.gnd)`,
      pins: `${pinList(uno)}, AREF, 5V (supply, = VCC), GND`,
      value: `Arduino Uno R3: the ATmega328P (profile 'atmega328p', ArduinoCore-avr numbering: 13 = D13, A0 = 14) with the Uno header names; options firmware, pwm, randomSeed`,
      dc: `board model = the MCU pins only: the 5 V / 3.3 V regulators (VIN, 3V3), the USB bridge and the on-board 'L' LED (buffered, does not load D13) are NOT modelled — power 5V from a source and wire your own LED and resistor`,
      details: profileDetails(uno),
    },
    ...Object.values(MCU_PROFILES).map(profileEntry),
    {
      type: 'VhdlBlock',
      example: `import counter from './counter.vhd';  const u2 = tb.add('U2', new VhdlBlock({ source: counter, entity: 'counter', generics: { N: 4 }, family: 'HC', vcc: 5 }))  ·  u2.pin('clk')  ·  u2.pin('q[0]')`,
      pins: `one per port bit: std_logic/boolean ports by name ('clk'), vectors '<port>[i]' per VHDL index, integer/enum ports '<port>[k]' per encoding bit (LSB 0); case-insensitive, 'q(0)' accepted`,
      value: `{ source: a .vhd import (or several, or inline VHDL text), entity?, architecture?, generics?: { N: 4, … }, family?: 'HC' | 'HCT' | 'CD4000', vcc?: 5 }`,
      dc: `a generic logic element: pure-digital nets (primitives / other VHDL blocks only) run on the event engine; a pin on an analog net is bridged with the family levels at the ideal vcc (ground = tb.gnd), outputs 3-state (VHDL 'Z' releases the pin); no supply pins. An input port left fully unconnected keeps its VHDL default. inout ports: pure-digital nets only`,
      details: [
        'VHDL subset (IEEE 1076-2008 flavored, std_logic_1164 + numeric_std): entities/architectures, generics, in/out/inout/buffer ports; signals, constants, variables, enums, subtypes; concurrent / conditional / selected assignments; process (list) / process (all) / leading wait until; if, case, for loops, exit/next; numeric_std arithmetic and comparisons, shifts, resize/to_unsigned/to_integer; rising_edge/falling_edge; for/if generate; component and entity instantiation; `after` delays (inertial)',
        'not supported (clear V703/V708): wait for/on, while loops, functions/procedures, packages, records/arrays/memories, real/bit/character, textio, std_logic_arith',
        'diagnostics: V701–V749 in the lint stage with the .vhd file:line:col (inline text: <bench line> (vhdl line:col)); V750–V755 at run time with process, time and VHDL location',
        'probes: logic \'U2.q[0]\' (tb.expect.logic), voltage \'U2.q[0]\' on bridged pins; the VHDL source travels in circuit documents (sources[])',
        'cheat sheet: AGENTS.md "VHDL blocks" (npx circuitsvibe agents); full subset table: src/vhdl/README.md in the repository',
      ],
    },
  ];
}

export const MCU_GRAMMAR_NOTES = `MICROCONTROLLERS  new Mcu({ profile: 'atmega328p'|'attiny85'|'esp32'|'rp2040', firmware: './app.fw.ts' }) · new ArduinoUno({ firmware })
                     firmware: export async function setup()/loop(); import { pinMode, digitalWrite, delay, … } from 'circuitsvibe/arduino';
                     every wait is \`await delay(ms)\`; VCC (Uno '5V') and GND MUST be wired (F139); runs in the transient only
SERIAL ASSERTIONS tb.expect.serial('U1', { tstop }?)  or  tb.expect.tran({...}).serial('U1')
                     .toContain(text, { by? })  .toNotContain(text)  .toMatch(/re/flags)  .toHaveLines(n | { min, max })
                     stages.tran.serial[]: { config, mcu, lines: [[t, text], ...], partial? }
MCU PROBES        logic 'U1.D13' (driven level / input level) · voltage 'U1.D9' · ratings R410 pin, R412 port group, R413 VCC/GND/total (exit 1)
VHDL BLOCKS       new VhdlBlock({ source: importedVhd, entity?, generics?, family?, vcc? }) · pins = port bits 'clk', 'q[0]'`;
