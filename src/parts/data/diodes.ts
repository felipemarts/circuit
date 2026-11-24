/**
 * Diodes: small-signal, rectifier, Schottky, Zener and 5 mm LEDs.
 *
 * Pin numbering: none of the cited datasheets number the two leads, so the
 * catalog convention (same as the simulator's Diode component and SPICE node
 * order) is used throughout: pin 1 = anode, pin 2 = cathode (band / short lead).
 */
import type { DiodePart } from '../types';

const ACCESSED = '2026-11-23';

const AXIAL_PINS = [
  { number: 1, name: 'anode', function: 'Anode' },
  { number: 2, name: 'cathode', function: 'Cathode (marked by the body band)' },
];

const LED_PINS = [
  { number: 1, name: 'anode', function: 'Anode (longer lead)' },
  { number: 2, name: 'cathode', function: 'Cathode (shorter lead, flat on the flange)' },
];

const VT_NOTE = 'Vt = kT/q = 25.85 mV (300 K)';

export const DIODES: DiodePart[] = [
  // -------------------------------------------------------------------------
  {
    id: '1N4148',
    category: 'diode',
    kind: 'signal',
    manufacturer: 'Vishay',
    description: 'Small-signal fast switching diode, 100 V, 150 mA average, trr 4 ns (DO-35)',
    package: { name: 'DO-35', pinCount: 2 },
    pins: AXIAL_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Vishay Semiconductors',
        title: '1N4148 Small Signal Fast Switching Diodes',
        document: '81857',
        revision: 'Rev. 1.6, 07-Nov-2024',
        url: 'https://www.vishay.com/docs/81857/1n4148.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'Nexperia',
        title: '1N4148 SPICE model (High-speed diodes), PSpice .prm',
        url: 'https://assets.nexperia.com/documents/spice-model/1N4148.prm',
        accessed: ACCESSED,
        note:
          'Published as .SUBCKT 1N4148 with D1 plus a parallel R1 = 5.827E+9 Ω (reverse-mode leakage aid, not represented in params). Header still says "NXP Semiconductors".',
      },
    ],
    model: {
      type: 'D',
      source: 'model',
      params: {
        Is: 4.352e-9,
        N: 1.906,
        BV: 110,
        IBV: 1e-4,
        Rs: 0.6458,
        Cjo: 7.048e-13,
        Vj: 0.869,
        M: 0.03,
        Fc: 0.5,
        Tt: 3.48e-9,
      },
    },
    ratings: {
      VRRM: { max: 100, unit: 'V' },
      VR: { max: 75, unit: 'V' },
      IFAV: { max: 0.15, unit: 'A', conditions: { VR: 0 } },
      IF: { max: 0.3, unit: 'A' },
      IFSM: { max: 2, unit: 'A', conditions: { tp: 1e-6 } },
      Pd: {
        max: 0.5,
        unit: 'W',
        conditions: { TL: 25, leadLength: 0.004 },
        note: 'TL ≤ 25 °C; 0.44 W at TL = 45 °C (l = 4 mm)',
      },
      TjMax: { max: 175, unit: '°C' },
    },
    characteristics: {
      VF: [{ max: 1, unit: 'V', conditions: { IF: 0.01 } }],
      IR: [
        { max: 25e-9, unit: 'A', conditions: { VR: 20 } },
        { max: 50e-6, unit: 'A', conditions: { VR: 20, TJ: 150 } },
        { max: 5e-6, unit: 'A', conditions: { VR: 75 } },
      ],
      Cj: [{ max: 4e-12, unit: 'F', conditions: { VR: 0, f: 1e6, VHF: 0.05 } }],
      trr: [
        { max: 8e-9, unit: 's', conditions: { IF: 0.01, IR: 0.01, iR: 0.001 } },
        { max: 4e-9, unit: 's', conditions: { IF: 0.01, VR: 6, iR: '0.1 x IR', RL: 100 } },
      ],
    },
    notes: [
      'IFRM (repetitive peak forward current) 500 mA.',
      'V(BR) min 100 V at IR = 100 µA (tp/T = 0.01, tp = 0.3 ms).',
      'RthJA 350 K/W (l = 4 mm, TL constant).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: '1N4007',
    category: 'diode',
    kind: 'rectifier',
    manufacturer: 'Vishay',
    description: 'General-purpose plastic rectifier, 1000 V, 1 A (1N4001–1N4007 family, DO-41)',
    package: { name: 'DO-41', pinCount: 2 },
    pins: AXIAL_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Vishay General Semiconductor',
        title: '1N4001 thru 1N4007 General Purpose Plastic Rectifier',
        document: '88503',
        revision: 'Revision: 29-Apr-2020',
        url: 'https://www.vishay.com/docs/88503/1n4001.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'Diodes Incorporated',
        title: '1N4007G SPICE model (DI_1N4007G, Glass Passivated Rectifier)',
        url: 'https://www.diodes.com/spice/download/344/1N4007G.spice.txt',
        accessed: ACCESSED,
        note:
          'Diodes Inc. publishes no model for the plain 1N4007; this is its glass-passivated 1N4007G (1 kV, 1 A) — same ratings class, used as the closest manufacturer model.',
      },
    ],
    model: {
      type: 'D',
      source: 'model',
      params: {
        Is: 65.4e-12,
        Rs: 42.2e-3,
        BV: 1000,
        IBV: 5e-6,
        Cjo: 14.8e-12,
        M: 0.333,
        N: 1.36,
        Tt: 2.88e-6,
      },
    },
    ratings: {
      VRRM: { max: 1000, unit: 'V' },
      VR: { max: 1000, unit: 'V', note: 'Maximum DC blocking voltage (VDC); VRMS max 700 V' },
      IFAV: { max: 1, unit: 'A', conditions: { TA: 75, leadLength: 0.0095 } },
      IFSM: { max: 30, unit: 'A', conditions: { tp: 8.3e-3, waveform: 'single half sine-wave, on rated load' } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      VF: [{ max: 1.1, unit: 'V', conditions: { IF: 1 } }],
      IR: [
        { max: 5e-6, unit: 'A', conditions: { VR: 1000, TA: 25 } },
        { max: 50e-6, unit: 'A', conditions: { VR: 1000, TA: 125 } },
      ],
      Cj: [{ typ: 15e-12, unit: 'F', conditions: { VR: 4, f: 1e6 } }],
    },
    notes: [
      'Non-repetitive square-wave surge: 45 A (tp = 1 ms), 35 A (2 ms), 30 A (5 ms).',
      'Datasheet gives no Pd rating; RθJA 50 °C/W, RθJL 25 °C/W typ (9.5 mm leads, PCB mounted).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: '1N5819',
    category: 'diode',
    kind: 'schottky',
    manufacturer: 'Diodes Incorporated',
    description: 'Schottky barrier rectifier, 40 V, 1 A (1N5817–1N5819 family, DO-41)',
    package: { name: 'DO-41', pinCount: 2 },
    pins: AXIAL_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Diodes Incorporated',
        title: '1N5817 - 1N5819 1.0A Schottky Barrier Rectifier',
        document: 'DS23001',
        revision: 'Rev. 10 - 2, April 2023',
        url: 'https://www.diodes.com/assets/Datasheets/ds23001.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'Diodes Incorporated',
        title: 'Schottky (.5A and Above) SPICE model collection — entry DI_1N5819',
        url: 'https://www.diodes.com/productcollection/spicemodels/8309/Schottky-%28.5A-and-Above%29.spice.txt?eid=94',
        accessed: ACCESSED,
        note: 'Same card as the per-part file 1N5819.spice.txt listed on diodes.com/design/tools/spice-models.',
      },
    ],
    model: {
      type: 'D',
      source: 'model',
      params: {
        Is: 390e-9,
        Rs: 0.115,
        BV: 40,
        IBV: 1e-3,
        Cjo: 203e-12,
        M: 0.333,
        N: 1.7,
        Tt: 4.32e-6,
      },
    },
    ratings: {
      VRRM: { max: 40, unit: 'V' },
      VR: { max: 40, unit: 'V', note: 'DC blocking voltage; VR(RMS) max 28 V' },
      IFAV: { max: 1, unit: 'A', conditions: { TL: 90, leadLength: 0.0095 } },
      IFSM: { max: 25, unit: 'A', conditions: { tp: 8.3e-3, waveform: 'single half sine-wave, on rated load' } },
      TjMax: { max: 125, unit: '°C' },
    },
    characteristics: {
      VF: [
        { max: 0.6, unit: 'V', conditions: { IF: 1 } },
        { max: 0.9, unit: 'V', conditions: { IF: 3 } },
      ],
      IR: [
        { max: 1e-3, unit: 'A', conditions: { VR: 40, TA: 25 } },
        { max: 10e-3, unit: 'A', conditions: { VR: 40, TA: 100 } },
      ],
      Cj: [{ typ: 110e-12, unit: 'F', conditions: { VR: 4, f: 1e6 } }],
    },
    notes: [
      'Datasheet gives no Pd rating; RθJL 15 °C/W, RθJA 50 °C/W typ.',
      'Model TT = 4.32 µs is as published by Diodes Inc. (Schottky has negligible stored charge in reality).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: '1N4733A',
    aliases: ['1N4733'],
    category: 'diode',
    kind: 'zener',
    manufacturer: 'onsemi',
    description: 'Zener diode 5.1 V ±5 %, 1 W (1N4728A–1N4758A family, DO-41 axial)',
    package: { name: 'DO-41', pinCount: 2 },
    pins: AXIAL_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'Zener Diodes 1N4728A - 1N4758A',
        document: '1N4736AT/D',
        revision: 'Rev. 10, August 2021',
        url: 'https://www.onsemi.com/download/data-sheet/pdf/1n4736at-d.pdf',
        accessed: ACCESSED,
        note: 'Package: axial lead CASE 017AH (JEDEC DO-204 variation AL = DO-41).',
      },
      {
        id: 'vishay',
        kind: 'datasheet',
        publisher: 'Vishay Semiconductors',
        title: '1N4728A to 1N4761A Zener Diodes',
        document: '85816',
        revision: 'Rev. 2.7, 07-Nov-2024',
        url: 'https://www.vishay.com/docs/85816/1n4728a.pdf',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'D',
      source: 'ds',
      estimated: true,
      note:
        'No manufacturer SPICE model found (checked onsemi and Vishay product pages, Diodes Inc. SPICE library, LTspice standard.dio). Only the breakdown point is set from the datasheet; forward-region params are omitted.',
      params: {
        BV: 5.1,
        IBV: 0.049,
      },
      estimatedParams: {
        BV: 'Nominal VZ = 5.1 V at IZT (datasheet table)',
        IBV: 'IZT = 49 mA, the VZ test current (datasheet table)',
      },
    },
    ratings: {
      Pd: {
        max: 1,
        unit: 'W',
        conditions: { TL: 50, leadLength: 0.0095 },
        note: 'TL ≤ 50 °C, lead length 3/8"; derate 6.67 mW/°C above 50 °C',
      },
      TjMax: { max: 200, unit: '°C' },
    },
    characteristics: {
      Vz: { min: 4.845, typ: 5.1, max: 5.355, unit: 'V', conditions: { IZ: 0.049, TL: 30 } },
      Izt: { typ: 0.049, unit: 'A', note: 'Test current IZ for VZ and ZZ' },
      Zzt: { max: 7, unit: 'Ω', conditions: { IZ: 0.049 } },
      Zzk: { max: 550, unit: 'Ω', conditions: { IZ: 0.001 } },
      Izk: { typ: 0.001, unit: 'A', note: 'Knee test current IZK for ZZK' },
      IR: [{ max: 10e-6, unit: 'A', conditions: { VR: 1 } }],
      VF: [{ max: 1.2, unit: 'V', conditions: { IF: 0.2 }, source: 'vishay' }],
    },
    notes: [
      'Non-repetitive peak reverse current IZSM 890 mA (8.3 ms square-wave surge).',
      'VZ measured at thermal equilibrium, TL = 30 °C ±1 °C, 3/8" lead length.',
      'Vishay rates the same type at Ptot 1.3 W (leads at 4 mm kept at ambient) and Tj 175 °C; onsemi values used.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'BZX79-C3V3',
    category: 'diode',
    kind: 'zener',
    manufacturer: 'Nexperia',
    description: 'Voltage regulator (Zener) diode 3.3 V ±5 % (C tolerance), 500 mW (BZX79 series, SOD27/DO-35)',
    package: { name: 'DO-35', pinCount: 2 },
    pins: AXIAL_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Nexperia (formerly NXP Semiconductors)',
        title: 'BZX79 series Voltage regulator diodes, Product data sheet',
        revision: '2002 Feb 27 (supersedes 1999 May 25)',
        url: 'https://assets.nexperia.com/documents/data-sheet/BZX79.pdf',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'D',
      source: 'ds',
      estimated: true,
      note:
        'No manufacturer SPICE model found (Nexperia product page lists none; not in LTspice standard.dio). Only the breakdown point is set from the datasheet; forward-region params are omitted.',
      params: {
        BV: 3.3,
        IBV: 0.005,
      },
      estimatedParams: {
        BV: 'Nominal VZ = 3.3 V (type designation; table range 3.1–3.5 V at IZtest = 5 mA)',
        IBV: 'IZtest = 5 mA (datasheet Table 1)',
      },
    },
    ratings: {
      IF: { max: 0.25, unit: 'A' },
      Pd: {
        max: 0.5,
        unit: 'W',
        conditions: { TA: 50 },
        note: 'Tie-point temperature ≤ 50 °C, lead length ≤ 8 mm; 400 mW on PCB without metallization pad',
      },
      TjMax: { max: 200, unit: '°C' },
    },
    characteristics: {
      Vz: { min: 3.1, max: 3.5, unit: 'V', conditions: { IZ: 0.005, TJ: 25 } },
      Izt: { typ: 0.005, unit: 'A', note: 'IZtest for VZ and rdif' },
      Zzt: { typ: 85, max: 95, unit: 'Ω', conditions: { IZ: 0.005 } },
      Zzk: { typ: 350, max: 600, unit: 'Ω', conditions: { IZ: 0.001 } },
      Izk: { typ: 0.001, unit: 'A', note: 'Test current for the low-current rdif' },
      IR: [{ max: 5e-6, unit: 'A', conditions: { VR: 1 } }],
      VF: [{ max: 0.9, unit: 'V', conditions: { IF: 0.01 } }],
      Cj: [{ max: 450e-12, unit: 'F', conditions: { VR: 0, f: 1e6 } }],
    },
    notes: [
      'IZSM max 6.0 A (tp = 100 µs square wave, Tamb = 25 °C); PZSM max 40 W.',
      'Temperature coefficient SZ at 5 mA: min −3.5, typ −2.4, max 0 mV/K.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'LED-RED-5MM',
    aliases: ['WP7113SRD/D'],
    category: 'diode',
    kind: 'led',
    manufacturer: 'Kingbright',
    description:
      'Generic 5 mm (T-1 3/4) red LED; data from Kingbright WP7113SRD/D (Super Bright Red GaAlAs, red diffused, 30°)',
    package: { name: 'T-1 3/4 (5 mm)', pinCount: 2 },
    pins: LED_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Kingbright',
        title: 'WP7113SRD/D T-1 3/4 (5mm) Solid State Lamp',
        document: 'DSAF2433 / 1101005271-02',
        revision: 'Rev. V.9A, 08/05/2020',
        url: 'https://www.kingbrightusa.com/images/catalog/SPEC/WP7113SRD-D.pdf',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'D',
      source: 'ds',
      estimated: true,
      note:
        'No vendor SPICE model. Fitted to the "Forward Current vs. Forward Voltage" figure (p. 3, Ta = 25 °C): 23 vertices of the vector curve between 1 and 30 mA, extracted from the PDF and mapped through the grid lines (1.5–2.5 V, 0–50 mA); linear least squares of V = N·Vt·ln(I/Is) + I·Rs, ' +
        VT_NOTE +
        '. Residual rms 1.9 mV, max 4 mV; model VF(20 mA) = 1.85 V (datasheet typ 1.85 V). Cjo omitted.',
      params: {
        Is: 1.41e-21,
        N: 1.575,
        Rs: 2.75,
      },
    },
    ratings: {
      VR: { max: 5, unit: 'V' },
      IF: { max: 0.03, unit: 'A' },
      IFP: { max: 0.155, unit: 'A', conditions: { duty: 0.1, tp: 1e-4 } },
      Pd: { max: 0.075, unit: 'W', conditions: { TA: 25 } },
      TjMax: { max: 115, unit: '°C' },
    },
    characteristics: {
      VF: [{ typ: 1.85, max: 2.5, unit: 'V', conditions: { IF: 0.02 } }],
      IR: [{ max: 10e-6, unit: 'A', conditions: { VR: 5 } }],
      Cj: [{ typ: 45e-12, unit: 'F', note: 'Test conditions not stated in the datasheet' }],
      wavelengthPeak: { typ: 655e-9, unit: 'm', conditions: { IF: 0.02 } },
      wavelengthDominant: { typ: 640e-9, unit: 'm', conditions: { IF: 0.02 } },
      luminousIntensity: { min: 0.4, typ: 0.6, unit: 'cd', conditions: { IF: 0.02 } },
    },
    notes: [
      'Selection guide also prints a second starred row (*120 min / *210 typ) footnoted "traceable to CIE127-2007"; the mcd row (400/600) is stored.',
      'Operating temperature −40 to +85 °C; RthJA 580 °C/W; VF tolerance ±0.1 V; TC of VF −1.9 mV/°C.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'LED-GREEN-5MM',
    aliases: ['WP7113GD'],
    category: 'diode',
    kind: 'led',
    manufacturer: 'Kingbright',
    description:
      'Generic 5 mm (T-1 3/4) green LED; data from Kingbright WP7113GD (Green GaP, green diffused, 30°)',
    package: { name: 'T-1 3/4 (5 mm)', pinCount: 2 },
    pins: LED_PINS,
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Kingbright',
        title: 'WP7113GD T-1 3/4 (5mm) Solid State Lamp',
        document: 'DSAE9335 / 1101005001',
        revision: 'Rev. V.12B, 04/02/2019',
        url: 'https://www.kingbrightusa.com/images/catalog/SPEC/WP7113GD.pdf',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'D',
      source: 'ds',
      estimated: true,
      note:
        'No vendor SPICE model. Fitted to the "Forward Current vs. Forward Voltage" figure (p. 3, Ta = 25 °C): 12 vertices of the vector curve between 1 and 20 mA, extracted from the PDF and mapped through the grid lines (1.5–2.5 V, 0–20 mA). N fixed at 2.0 (an unconstrained fit gave a non-physical N = 0.58 because the drawn curve is almost straight above 6 mA); Is and Rs by linear least squares of V = N·Vt·ln(I/Is) + I·Rs, ' +
        VT_NOTE +
        '. Residual rms 12 mV, max 29 mV; model VF(10 mA) = 2.04 V (datasheet typ 2.0 V). Cjo omitted.',
      params: {
        Is: 5.73e-19,
        N: 2,
        Rs: 10.89,
      },
    },
    ratings: {
      VR: { max: 5, unit: 'V' },
      IF: { max: 0.025, unit: 'A' },
      IFP: { max: 0.14, unit: 'A', conditions: { duty: 0.1, tp: 1e-4 } },
      Pd: { max: 0.0625, unit: 'W', conditions: { TA: 25 } },
      TjMax: { max: 110, unit: '°C' },
    },
    characteristics: {
      VF: [{ typ: 2.0, max: 2.4, unit: 'V', conditions: { IF: 0.01 } }],
      IR: [{ max: 10e-6, unit: 'A', conditions: { VR: 5 } }],
      Cj: [{ typ: 15e-12, unit: 'F', note: 'Test conditions not stated in the datasheet' }],
      wavelengthPeak: { typ: 565e-9, unit: 'm', conditions: { IF: 0.01 } },
      wavelengthDominant: { typ: 568e-9, unit: 'm', conditions: { IF: 0.01 } },
      luminousIntensity: { min: 0.015, typ: 0.03, unit: 'cd', conditions: { IF: 0.01 } },
    },
    notes: [
      'Optical/electrical characteristics are specified at IF = 10 mA (not 20 mA).',
      'Operating temperature −40 to +85 °C; RthJA 600 °C/W; VF tolerance ±0.1 V; TC of VF −1.8 mV/°C.',
    ],
  },
];
