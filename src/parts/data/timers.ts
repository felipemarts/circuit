/**
 * 555 timer — verified datasheet data.
 * VOL/VOH are stored as absolute voltages at the stated VCC (as printed).
 * Percent and ppm figures are stored as plain fractions (unit '1'): 1 % → 0.01, 50 ppm/°C → 50e-6 per °C.
 */
import type { TimerPart } from '../types';

const ACCESSED = '2026-11-23';

export const TIMERS: TimerPart[] = [
  {
    id: 'NE555',
    aliases: ['LM555', 'NE555P', 'LM555CN'],
    category: 'timer',
    manufacturer: 'Texas Instruments',
    description: 'Bipolar precision timer, monostable/astable, 200 mA totem-pole output',
    package: { name: 'DIP-8', pinCount: 8 },
    pins: [
      { number: 1, name: 'GND', function: 'Ground' },
      { number: 2, name: 'TRIG', function: 'Trigger: TRIG < ½ CONT sets output high, discharge open' },
      { number: 3, name: 'OUT', function: 'Timer output (high current)' },
      { number: 4, name: 'RESET', function: 'Active-low reset: forces output and discharge low' },
      { number: 5, name: 'CONT', function: 'Control voltage: comparator thresholds, outputs 2/3 × VCC' },
      { number: 6, name: 'THRES', function: 'Threshold: THRES > CONT sets output low, discharge low' },
      { number: 7, name: 'DISCH', function: 'Open-collector discharge output' },
      { number: 8, name: 'VCC', function: 'Supply voltage' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Texas Instruments',
        title: 'xx555 Precision Timers',
        document: 'SLFS022K',
        revision: 'September 1973 – revised March 2026',
        url: 'https://www.ti.com/lit/ds/symlink/ne555.pdf',
        accessed: ACCESSED,
        note: 'NE555 rows of Sections 5.5/5.6 (TA = 25 °C, VCC = 5 V to 15 V). Rev K dropped the initial timing-error spec.',
      },
      {
        id: 'lm555',
        kind: 'datasheet',
        publisher: 'Texas Instruments',
        title: 'LM555 Timer',
        document: 'SNAS548D',
        revision: 'February 2000 – revised January 2015',
        url: 'https://www.ti.com/lit/ds/symlink/lm555.pdf',
        accessed: ACCESSED,
        note: 'LM555 (alias): source of initial timing accuracy, pin-7 saturation at 15 mA / 4.5 mA, and PDIP power dissipation.',
      },
    ],
    ratings: {
      supplyMax: { max: 18, unit: 'V', note: 'With respect to GND.' },
      inputVoltageMax: { max: 0, unit: 'V', relativeTo: 'V+', note: 'CONT, RESET, THRES, TRIG: VI ≤ VCC (printed max "VCC").' },
      Pd: {
        max: 1.18,
        unit: 'W',
        source: 'lm555',
        note: 'LM555CN (PDIP) / LM555CM; derate above 25 °C with RθJA = 106 °C/W (PDIP).',
      },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      supply: { min: 4.5, max: 16, unit: 'V', note: 'Recommended, NE555 (SE555: 18 V).' },
      thresholdLevel: {
        typ: 2 / 3,
        unit: 'xVCC',
        note: 'Printed "2/3 × VCC" (function table and CONT pin description); typ 10 V at VCC = 15 V, 3.3 V at VCC = 5 V.',
      },
      triggerLevel: {
        typ: 1 / 3,
        unit: 'xVCC',
        note: 'Printed "1/3 × VCC" (function table; TRIG < ½ CONT); typ 5 V at VCC = 15 V, 1.67 V at VCC = 5 V.',
      },
      thresholdVoltage: [
        { min: 8.8, typ: 10, max: 11.2, unit: 'V', conditions: { VCC: 15, TA: 25 } },
        { min: 2.4, typ: 3.3, max: 4.2, unit: 'V', conditions: { VCC: 5, TA: 25 } },
      ],
      triggerVoltage: [
        { min: 4.5, typ: 5, max: 5.6, unit: 'V', conditions: { VCC: 15, TA: 25 } },
        { min: 1.1, typ: 1.67, max: 2.2, unit: 'V', conditions: { VCC: 5, TA: 25 } },
      ],
      thresholdCurrent: {
        typ: 30e-9,
        max: 250e-9,
        unit: 'A',
        conditions: { VCC: '5 V to 15 V', TA: 25 },
        note: 'Sets max RA + RB: ≅ 3.4 MΩ at VCC = 5 V, ≅ 10 MΩ at VCC = 15 V.',
      },
      triggerCurrent: { typ: 0.5e-6, max: 2e-6, unit: 'A', conditions: { VTRIG: 0, VCC: '5 V to 15 V', TA: 25 } },
      resetVoltage: { min: 0.3, typ: 0.7, max: 1, unit: 'V', conditions: { VCC: '5 V to 15 V', TA: 25 } },
      resetCurrent: [
        { typ: 0.1e-3, max: 0.4e-3, unit: 'A', conditions: { VRESET: 'VCC', TA: 25 } },
        // magnitude
        { typ: 0.4e-3, max: 1.5e-3, unit: 'A', conditions: { VRESET: 0, TA: 25 }, note: 'Magnitude; printed −0.4 mA typ / −1.5 mA max (flows out of the pin).' },
      ],
      controlVoltage: [
        { min: 9, typ: 10, max: 11, unit: 'V', conditions: { VCC: 15, TA: 25 }, note: 'CONT open circuit.' },
        { min: 2.6, typ: 3.3, max: 4, unit: 'V', conditions: { VCC: 5, TA: 25 }, note: 'CONT open circuit.' },
      ],
      dischargeSaturation: [
        { typ: 0.15, max: 0.4, unit: 'V', conditions: { VCC: 5, IO: 8e-3, TA: 25 }, note: 'DISCH switch on-state voltage.' },
        { typ: 0.18, unit: 'V', conditions: { VCC: 15, IO: 15e-3, TA: 25 }, source: 'lm555', note: 'LM555 "Pin 7 Sat", output low.' },
        { typ: 0.08, max: 0.2, unit: 'V', conditions: { VCC: 4.5, IO: 4.5e-3, TA: 25 }, source: 'lm555', note: 'LM555 "Pin 7 Sat", output low.' },
      ],
      dischargeLeakage: { typ: 20e-9, max: 100e-9, unit: 'A', conditions: { VCC: '5 V to 15 V', TA: 25 }, note: 'DISCH switch off-state current.' },
      VOL: [
        { typ: 0.1, max: 0.25, unit: 'V', conditions: { VCC: 15, IOL: 10e-3, TA: 25 } },
        { typ: 0.4, max: 0.75, unit: 'V', conditions: { VCC: 15, IOL: 50e-3, TA: 25 } },
        { typ: 2, max: 2.5, unit: 'V', conditions: { VCC: 15, IOL: 100e-3, TA: 25 } },
        { typ: 2.5, unit: 'V', conditions: { VCC: 15, IOL: 200e-3, TA: 25 } },
        { typ: 0.1, max: 0.35, unit: 'V', conditions: { VCC: 5, IOL: 5e-3, TA: 25 } },
        { typ: 0.15, max: 0.4, unit: 'V', conditions: { VCC: 5, IOL: 8e-3, TA: 25 } },
      ],
      VOH: [
        { min: 12.75, typ: 13.3, unit: 'V', conditions: { VCC: 15, IOH: -100e-3, TA: 25 } },
        { typ: 12.5, unit: 'V', conditions: { VCC: 15, IOH: -200e-3, TA: 25 } },
        { min: 2.75, typ: 3.3, unit: 'V', conditions: { VCC: 5, IOH: -100e-3, TA: 25 } },
      ],
      // magnitude
      outputCurrentMax: { max: 0.225, unit: 'A', note: 'Abs max IO ±225 mA (magnitude); recommended ±200 mA.' },
      supplyCurrent: [
        { typ: 10e-3, max: 15e-3, unit: 'A', conditions: { VCC: 15, output: 'low', load: 'none', TA: 25 } },
        { typ: 3e-3, max: 6e-3, unit: 'A', conditions: { VCC: 5, output: 'low', load: 'none', TA: 25 } },
        { typ: 9e-3, max: 13e-3, unit: 'A', conditions: { VCC: 15, output: 'high', load: 'none', TA: 25 } },
        { typ: 2e-3, max: 5e-3, unit: 'A', conditions: { VCC: 5, output: 'high', load: 'none', TA: 25 } },
      ],
      riseTime: { typ: 100e-9, max: 300e-9, unit: 's', conditions: { CL: 15e-12, TA: 25, levels: '20% to 80%' }, note: 'Specified by design/characterization, not production tested.' },
      fallTime: { typ: 100e-9, max: 300e-9, unit: 's', conditions: { CL: 15e-12, TA: 25, levels: '80% to 20%' }, note: 'Specified by design/characterization, not production tested.' },
      timingError: [
        {
          typ: 50e-6,
          unit: '1',
          conditions: { parameter: 'temperature coefficient of timing interval, per °C', mode: 'monostable', RA: '2 kΩ to 100 kΩ', C: 0.1e-6, TA: '0 to 70 °C' },
          note: 'Printed 50 ppm/°C typ.',
        },
        {
          typ: 150e-6,
          unit: '1',
          conditions: { parameter: 'temperature coefficient of timing interval, per °C', mode: 'astable', RA: '1 kΩ to 100 kΩ', C: 0.1e-6, TA: '0 to 70 °C' },
          note: 'Printed 150 ppm/°C typ.',
        },
        {
          typ: 0.001,
          max: 0.005,
          unit: '1',
          conditions: { parameter: 'supply-voltage sensitivity of timing interval, per V', mode: 'monostable', TA: 25 },
          note: 'Printed 0.1 %/V typ, 0.5 %/V max.',
        },
        {
          typ: 0.003,
          unit: '1',
          conditions: { parameter: 'supply-voltage sensitivity of timing interval, per V', mode: 'astable', TA: 25 },
          note: 'Printed 0.3 %/V typ.',
        },
        {
          typ: 0.01,
          unit: '1',
          conditions: { parameter: 'initial accuracy', mode: 'monostable', RA: '1 kΩ to 100 kΩ', C: 0.1e-6, TA: 25 },
          source: 'lm555',
          note: 'LM555: printed 1 % typ; 1.5 % accuracy over temperature.',
        },
        {
          typ: 0.0225,
          unit: '1',
          conditions: { parameter: 'initial accuracy', mode: 'astable', RA: '1 kΩ to 100 kΩ', RB: '1 kΩ to 100 kΩ', C: 0.1e-6, TA: 25 },
          source: 'lm555',
          note: 'LM555: printed 2.25 % typ; 3.0 % accuracy over temperature.',
        },
      ],
      maxFrequency: {
        max: 100e3,
        unit: 'Hz',
        note: 'Application guidance, not a tested limit: "use at maximum frequency of 100kHz or below" (astable, to reduce distortion); Overview says < 1 mHz to 100 kHz.',
      },
    },
    notes: [
      'Output sinks or sources up to 200 mA (TTL-compatible). The threshold and trigger levels follow CONT when CONT is driven externally.',
      'The trigger level is half the CONT voltage, i.e. 1/3 × VCC with CONT open.',
    ],
  },
];
