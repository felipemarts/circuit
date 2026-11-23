import type { BjtPart } from '../types';

/**
 * Bipolar transistors. Primary source for every part: onsemi datasheet (first citation).
 * SPICE cards: onsemi-published .LIB files (MODPEX fits) where available; BC557B from the
 * stock LTspice standard.bjt (Linear Technology / Analog Devices). No SPICE defaults added.
 * PNP parts: ratings, characteristic values and test-condition currents/voltages are stored
 * as magnitudes (the datasheet prints them negative); SPICE params keep SPICE conventions.
 */

const ACCESSED = '2026-11-23';

const LTSPICE_STANDARD_BJT =
  'https://raw.githubusercontent.com/mpkopec/ltspice-lib/2df358aae06c33c6974a687f12b13dc333de7a8c/cmp/standard.bjt';

export const BJTS: BjtPart[] = [
  // -------------------------------------------------------------------------
  {
    id: '2N3904',
    category: 'bjt',
    polarity: 'NPN',
    manufacturer: 'onsemi',
    description: 'General-purpose NPN small-signal transistor, 40 V / 200 mA',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'E', function: 'Emitter' },
      { number: 2, name: 'B', function: 'Base' },
      { number: 3, name: 'C', function: 'Collector' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: '2N3903, 2N3904 General Purpose Transistors NPN Silicon',
        document: '2N3903/D',
        revision: 'Rev. 9, August 2021',
        url: 'https://www.onsemi.com/pdf/datasheet/2n3903-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'onsemi',
        title: '2N3904 PSpice model (MODPEX, Symmetry Design Systems)',
        document: '2N3904.LIB',
        revision: 'Model generated on Aug 7, 01',
        url: 'https://www.onsemi.com/pub/Collateral/2N3904.LIB',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'NPN',
      source: 'model',
      params: {
        Is: 1.26532e-10, Bf: 206.302, Nf: 1.5, Vaf: 1000, Ikf: 0.0272221, Ise: 2.30771e-9,
        Ne: 3.31052, Br: 20.6302, Nr: 2.89609, Var: 9.39809, Ikr: 0.272221, Isc: 2.30771e-9,
        Nc: 1.9876, Rb: 5.8376, Irb: 50.3624, Rbm: 0.634251, Re: 0.0001, Rc: 2.65711,
        Xtb: 0.1, Xti: 1, Eg: 1.05, Cje: 4.64214e-12, Vje: 0.4, Mje: 0.256227,
        Tf: 4.19578e-10, Xtf: 0.906167, Vtf: 8.75418, Itf: 0.0105823,
        Cjc: 3.76961e-12, Vjc: 0.4, Mjc: 0.238109, Xcjc: 0.8, Fc: 0.512134,
        Cjs: 0, Vjs: 0.75, Mjs: 0.5, Tr: 6.82023e-8, Ptf: 0, Kf: 0, Af: 1,
      },
    },
    ratings: {
      Vceo: { max: 40, unit: 'V' },
      Vcbo: { max: 60, unit: 'V' },
      Vebo: { max: 6.0, unit: 'V' },
      IcMax: { max: 0.2, unit: 'A' },
      Pd: { max: 0.625, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 1.5, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      hFE: [
        { min: 40, unit: '1', conditions: { IC: 0.1e-3, VCE: 1.0, TA: 25 } },
        { min: 70, unit: '1', conditions: { IC: 1e-3, VCE: 1.0, TA: 25 } },
        { min: 100, max: 300, unit: '1', conditions: { IC: 10e-3, VCE: 1.0, TA: 25 } },
        { min: 60, unit: '1', conditions: { IC: 50e-3, VCE: 1.0, TA: 25 } },
        { min: 30, unit: '1', conditions: { IC: 100e-3, VCE: 1.0, TA: 25 } },
      ],
      VCEsat: [
        { max: 0.2, unit: 'V', conditions: { IC: 10e-3, IB: 1e-3, TA: 25 } },
        { max: 0.3, unit: 'V', conditions: { IC: 50e-3, IB: 5e-3, TA: 25 } },
      ],
      VBEsat: [
        { min: 0.65, max: 0.85, unit: 'V', conditions: { IC: 10e-3, IB: 1e-3, TA: 25 } },
        { max: 0.95, unit: 'V', conditions: { IC: 50e-3, IB: 5e-3, TA: 25 } },
      ],
      fT: [{ min: 300e6, unit: 'Hz', conditions: { IC: 10e-3, VCE: 20, f: 100e6, TA: 25 } }],
      Cob: [{ max: 4.0e-12, unit: 'F', conditions: { VCB: 5.0, IE: 0, f: 1e6, TA: 25 } }],
      Cib: [{ max: 8.0e-12, unit: 'F', conditions: { VEB: 0.5, IC: 0, f: 1e6, TA: 25 } }],
    },
    notes: [
      'TO-92 Case 29 Style 1 pinout (1 = emitter, 2 = base, 3 = collector).',
      'ICEX max 50 nA at VCE = 30 V, VEB = 3 V (cutoff with reverse-biased base).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: '2N3906',
    category: 'bjt',
    polarity: 'PNP',
    manufacturer: 'onsemi',
    description: 'General-purpose PNP small-signal transistor, 40 V / 200 mA',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'E', function: 'Emitter' },
      { number: 2, name: 'B', function: 'Base' },
      { number: 3, name: 'C', function: 'Collector' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: '2N3906 General Purpose Transistors PNP Silicon',
        document: '2N3906/D',
        revision: 'Rev. 4, February 2010',
        url: 'https://www.onsemi.com/pdf/datasheet/2n3906-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'onsemi',
        title: '2N3906 PSpice model (MODPEX, Symmetry Design Systems)',
        document: '2N3906.LIB',
        revision: 'Model generated on Aug 7, 01',
        url: 'https://www.onsemi.com/pub/Collateral/2N3906.LIB',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'PNP',
      source: 'model',
      params: {
        Is: 7.75521e-12, Bf: 194.093, Nf: 1.35509, Vaf: 156.436, Ikf: 0.0660057, Ise: 1.88546e-12,
        Ne: 1.81673, Br: 3.41317, Nr: 1.5, Var: 5.86061, Ikr: 1.70599, Isc: 7.64281e-10,
        Nc: 1.92376, Rb: 6.48961, Irb: 0.1, Rbm: 0.1, Re: 0.0001, Rc: 2.45044,
        Xtb: 0.1, Xti: 1, Eg: 1.05, Cje: 6.11928e-12, Vje: 0.4, Mje: 0.248812,
        Tf: 5.21843e-10, Xtf: 0.932702, Vtf: 9.1046, Itf: 0.0106472,
        Cjc: 6.85007e-12, Vjc: 0.4, Mjc: 0.279018, Xcjc: 0.9, Fc: 0.478887,
        Cjs: 0, Vjs: 0.75, Mjs: 0.5, Tr: 4.30605e-7, Ptf: 0, Kf: 0, Af: 1,
      },
    },
    // magnitudes (PNP)
    ratings: {
      Vceo: { max: 40, unit: 'V' }, // magnitude
      Vcbo: { max: 40, unit: 'V' }, // magnitude
      Vebo: { max: 5.0, unit: 'V' }, // magnitude
      IcMax: { max: 0.2, unit: 'A' }, // magnitude
      Pd: { max: 0.625, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 1.5, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    // magnitudes (PNP): condition currents/voltages and limits
    characteristics: {
      hFE: [
        { min: 60, unit: '1', conditions: { IC: 0.1e-3, VCE: 1.0, TA: 25 } },
        { min: 80, unit: '1', conditions: { IC: 1e-3, VCE: 1.0, TA: 25 } },
        { min: 100, max: 300, unit: '1', conditions: { IC: 10e-3, VCE: 1.0, TA: 25 } },
        { min: 60, unit: '1', conditions: { IC: 50e-3, VCE: 1.0, TA: 25 } },
        { min: 30, unit: '1', conditions: { IC: 100e-3, VCE: 1.0, TA: 25 } },
      ],
      VCEsat: [
        { max: 0.25, unit: 'V', conditions: { IC: 10e-3, IB: 1e-3, TA: 25 } },
        { max: 0.4, unit: 'V', conditions: { IC: 50e-3, IB: 5e-3, TA: 25 } },
      ],
      VBEsat: [
        { min: 0.65, max: 0.85, unit: 'V', conditions: { IC: 10e-3, IB: 1e-3, TA: 25 } },
        { max: 0.95, unit: 'V', conditions: { IC: 50e-3, IB: 5e-3, TA: 25 } },
      ],
      fT: [{ min: 250e6, unit: 'Hz', conditions: { IC: 10e-3, VCE: 20, f: 100e6, TA: 25 } }],
      Cob: [{ max: 4.5e-12, unit: 'F', conditions: { VCB: 5.0, IE: 0, f: 1e6, TA: 25 } }],
      Cib: [{ max: 10e-12, unit: 'F', conditions: { VEB: 0.5, IC: 0, f: 1e6, TA: 25 } }],
    },
    notes: [
      'TO-92 Case 29 Style 1 pinout (1 = emitter, 2 = base, 3 = collector).',
      'PNP: ratings and characteristic values/conditions stored as magnitudes.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'BC547B',
    aliases: ['BC547BG'],
    category: 'bjt',
    polarity: 'NPN',
    manufacturer: 'onsemi',
    description: 'NPN amplifier transistor, 45 V / 100 mA, hFE group B (200–450 at 2 mA)',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'C', function: 'Collector' },
      { number: 2, name: 'B', function: 'Base' },
      { number: 3, name: 'E', function: 'Emitter' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'BC546B, BC547A, B, C, BC548B, C Amplifier Transistors NPN Silicon',
        document: 'BC546/D',
        revision: 'Rev. 8, August 2021',
        url: 'https://www.onsemi.com/pdf/datasheet/bc546-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'onsemi',
        title: 'BC547B PSpice model (MODPEX, Symmetry Design Systems)',
        document: 'BC547B.LIB',
        revision: 'Model generated on May 12, 05',
        url: 'https://www.onsemi.com/pub/Collateral/BC547B.LIB',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'NPN',
      source: 'model',
      params: {
        Is: 7.443e-11, Bf: 1343.59, Nf: 1.42606, Vaf: 80.4901, Ikf: 0.427163, Ise: 2.4623e-10,
        Ne: 2.73946, Br: 62.79, Nr: 1.5, Var: 1.0092, Ikr: 4.27163, Isc: 2.4623e-10,
        Nc: 1.9119, Rb: 0.1, Irb: 0.1, Rbm: 0.1, Re: 0.579065, Rc: 3.01102,
        Xtb: 0.1, Xti: 2.25359, Eg: 1.05, Cje: 7.34106e-12, Vje: 0.586136, Mje: 0.33309,
        Tf: 5.7202e-10, Xtf: 4.45797, Vtf: 26.03, Itf: 0.487193,
        Cjc: 4.04665e-12, Vjc: 0.95, Mjc: 0.343664, Xcjc: 0.799994, Fc: 0.8,
        Cjs: 0, Vjs: 0.75, Mjs: 0.5, Tr: 1e-7, Ptf: 0, Kf: 0, Af: 1,
      },
      note: 'Published MODPEX fit; BF=1343.59 with NF=1.43 and high ISE is as published (effective gain is set by the ISE/NE and IKF terms).',
    },
    ratings: {
      Vceo: { max: 45, unit: 'V' },
      Vcbo: { max: 50, unit: 'V' },
      Vebo: { max: 6.0, unit: 'V' },
      IcMax: { max: 0.1, unit: 'A' },
      Pd: { max: 0.625, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 1.5, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      hFE: [
        { typ: 150, unit: '1', conditions: { IC: 10e-6, VCE: 5.0, TA: 25 } },
        { min: 200, typ: 290, max: 450, unit: '1', conditions: { IC: 2e-3, VCE: 5.0, TA: 25 } },
        { typ: 180, unit: '1', conditions: { IC: 100e-3, VCE: 5.0, TA: 25 } },
      ],
      VCEsat: [
        { typ: 0.09, max: 0.25, unit: 'V', conditions: { IC: 10e-3, IB: 0.5e-3, TA: 25 } },
        { typ: 0.2, max: 0.6, unit: 'V', conditions: { IC: 100e-3, IB: 5e-3, TA: 25 } },
        {
          typ: 0.3,
          max: 0.6,
          unit: 'V',
          conditions: { IC: 10e-3, IB: 'value giving IC = 11 mA at VCE = 1.0 V (Note 1)', TA: 25 },
        },
      ],
      VBEsat: [{ typ: 0.7, unit: 'V', conditions: { IC: 10e-3, IB: 0.5e-3, TA: 25 } }],
      VBEon: [
        { min: 0.55, max: 0.7, unit: 'V', conditions: { IC: 2e-3, VCE: 5.0, TA: 25 } },
        { max: 0.77, unit: 'V', conditions: { IC: 10e-3, VCE: 5.0, TA: 25 } },
      ],
      fT: [{ min: 150e6, typ: 300e6, unit: 'Hz', conditions: { IC: 10e-3, VCE: 5.0, f: 100e6, TA: 25 } }],
      Cob: [{ typ: 1.7e-12, max: 4.5e-12, unit: 'F', conditions: { VCB: 10, IC: 0, f: 1e6, TA: 25 } }],
      Cib: [{ typ: 10e-12, unit: 'F', conditions: { VEB: 0.5, IC: 0, f: 1e6, TA: 25 } }],
    },
    notes: [
      'TO-92 Case 29 Style 17 pinout (1 = collector, 2 = base, 3 = emitter) — differs from 2N3904.',
      'ICES max 15 nA at VCE = 50 V, VBE = 0 (BC547).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'BC557B',
    aliases: ['BC557BG'],
    category: 'bjt',
    polarity: 'PNP',
    manufacturer: 'onsemi',
    description: 'PNP amplifier transistor, 45 V / 100 mA, hFE group B (180–460 at 2 mA)',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'C', function: 'Collector' },
      { number: 2, name: 'B', function: 'Base' },
      { number: 3, name: 'E', function: 'Emitter' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'BC556B, BC557A, B, C, BC558B Amplifier Transistors PNP Silicon',
        document: 'BC556B/D',
        revision: 'Rev. 3, March 2007',
        url: 'https://www.onsemi.com/pdf/datasheet/bc556b-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'ltspice',
        kind: 'library',
        publisher: 'Linear Technology / Analog Devices (LTspice)',
        title: 'LTspice IV standard.bjt (stock library, mirrored on GitHub)',
        document: 'lib/cmp/standard.bjt',
        revision: 'LTspice IV library update 2016-04-02 (Copyright 2000-2016 Linear Technology Corporation)',
        url: LTSPICE_STANDARD_BJT,
        accessed: ACCESSED,
        note: 'GitHub mirror mpkopec/ltspice-lib, commit 2df358a. Line carries mfg=NXP. onsemi does not publish a BC557B .LIB at the /pub/Collateral path.',
      },
    ],
    model: {
      type: 'PNP',
      source: 'ltspice',
      params: {
        Is: 3.83e-14, Nf: 1.008, Ise: 1.22e-14, Ne: 1.528, Bf: 344.4, Ikf: 0.08039, Vaf: 21.11,
        Nr: 1.005, Isc: 2.85e-13, Nc: 1.28, Br: 14.84, Ikr: 0.047, Var: 32.02,
        Rb: 1, Irb: 1e-6, Rbm: 1, Re: 0.6202, Rc: 0.5713, Xtb: 0, Eg: 1.11, Xti: 3,
        Cje: 1.23e-11, Vje: 0.6106, Mje: 0.378, Tf: 5.6e-10, Xtf: 3.414, Vtf: 5.23, Itf: 0.1483,
        Ptf: 0, Cjc: 1.08e-11, Vjc: 0.1022, Mjc: 0.3563, Xcjc: 0.6288, Tr: 1e-32,
        Cjs: 0, Vjs: 0.75, Mjs: 0.333, Fc: 0.8027,
      },
      note: 'Vceo/Icrating/mfg on the LTspice line are metadata, not model parameters, and are not in params. Model is NXP-origin (BC557B is second-sourced), not onsemi.',
    },
    ratings: {
      Vceo: { max: 45, unit: 'V' }, // magnitude
      Vcbo: { max: 50, unit: 'V' }, // magnitude
      Vebo: { max: 5.0, unit: 'V' }, // magnitude
      IcMax: { max: 0.1, unit: 'A' }, // magnitude
      IcPeak: { max: 0.2, unit: 'A' }, // magnitude
      Pd: { max: 0.625, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 1.5, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    // magnitudes (PNP): values and condition currents/voltages
    characteristics: {
      hFE: [
        { typ: 150, unit: '1', conditions: { IC: 10e-6, VCE: 5.0, TA: 25 } },
        { min: 180, typ: 290, max: 460, unit: '1', conditions: { IC: 2e-3, VCE: 5.0, TA: 25 } },
        { typ: 180, unit: '1', conditions: { IC: 100e-3, VCE: 5.0, TA: 25 } },
      ],
      VCEsat: [
        { typ: 0.075, max: 0.3, unit: 'V', conditions: { IC: 10e-3, IB: 0.5e-3, TA: 25 } },
        {
          typ: 0.3,
          max: 0.6,
          unit: 'V',
          conditions: { IC: 10e-3, IB: 'value giving IC = 11 mA at VCE = 1.0 V (Note 1)', TA: 25 },
        },
        { typ: 0.25, max: 0.65, unit: 'V', conditions: { IC: 100e-3, IB: 5e-3, TA: 25 } },
      ],
      VBEsat: [
        { typ: 0.7, unit: 'V', conditions: { IC: 10e-3, IB: 0.5e-3, TA: 25 } },
        { typ: 1.0, unit: 'V', conditions: { IC: 100e-3, IB: 5e-3, TA: 25 } },
      ],
      VBEon: [
        { min: 0.55, typ: 0.62, max: 0.7, unit: 'V', conditions: { IC: 2e-3, VCE: 5.0, TA: 25 } },
        { typ: 0.7, max: 0.82, unit: 'V', conditions: { IC: 10e-3, VCE: 5.0, TA: 25 } },
      ],
      fT: [{ typ: 320e6, unit: 'Hz', conditions: { IC: 10e-3, VCE: 5.0, f: 100e6, TA: 25 } }],
      Cob: [{ typ: 3.0e-12, max: 6.0e-12, unit: 'F', conditions: { VCB: 10, IC: 0, f: 1e6, TA: 25 } }],
    },
    notes: [
      'TO-92 Case 29 Style 17 pinout (1 = collector, 2 = base, 3 = emitter).',
      'PNP: ratings and characteristic values/conditions stored as magnitudes.',
      'Peak base current IBM 200 mA. Datasheet gives no input capacitance.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: '2N2222A',
    aliases: ['P2N2222A', 'P2N2222AG'],
    category: 'bjt',
    polarity: 'NPN',
    manufacturer: 'onsemi',
    description: 'NPN general-purpose amplifier/switch, 40 V / 600 mA (onsemi P2N2222A, TO-92)',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'C', function: 'Collector' },
      { number: 2, name: 'B', function: 'Base' },
      { number: 3, name: 'E', function: 'Emitter' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'P2N2222A Amplifier Transistors NPN Silicon',
        document: 'P2N2222A/D',
        revision: 'Rev. 7, January 2013',
        url: 'https://www.onsemi.com/pdf/datasheet/p2n2222a-d.pdf',
        accessed: ACCESSED,
      },
    ],
    ratings: {
      Vceo: { max: 40, unit: 'V' },
      Vcbo: { max: 75, unit: 'V' },
      Vebo: { max: 6.0, unit: 'V' },
      IcMax: { max: 0.6, unit: 'A' },
      Pd: { max: 0.625, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 1.5, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      hFE: [
        { min: 35, unit: '1', conditions: { IC: 0.1e-3, VCE: 10, TA: 25 } },
        { min: 50, unit: '1', conditions: { IC: 1e-3, VCE: 10, TA: 25 } },
        { min: 75, unit: '1', conditions: { IC: 10e-3, VCE: 10, TA: 25 } },
        { min: 35, unit: '1', conditions: { IC: 10e-3, VCE: 10, TA: -55 } },
        { min: 100, max: 300, unit: '1', conditions: { IC: 150e-3, VCE: 10, TA: 25 } },
        { min: 50, unit: '1', conditions: { IC: 150e-3, VCE: 1.0, TA: 25 } },
        { min: 40, unit: '1', conditions: { IC: 500e-3, VCE: 10, TA: 25 } },
      ],
      VCEsat: [
        { max: 0.3, unit: 'V', conditions: { IC: 150e-3, IB: 15e-3, TA: 25 } },
        { max: 1.0, unit: 'V', conditions: { IC: 500e-3, IB: 50e-3, TA: 25 } },
      ],
      VBEsat: [
        { min: 0.6, max: 1.2, unit: 'V', conditions: { IC: 150e-3, IB: 15e-3, TA: 25 } },
        { max: 2.0, unit: 'V', conditions: { IC: 500e-3, IB: 50e-3, TA: 25 } },
      ],
      fT: [{ min: 300e6, unit: 'Hz', conditions: { IC: 20e-3, VCE: 20, f: 100e6, TA: 25 } }],
      Cob: [{ max: 8.0e-12, unit: 'F', conditions: { VCB: 10, IE: 0, f: 1e6, TA: 25 } }],
      Cib: [{ max: 25e-12, unit: 'F', conditions: { VEB: 0.5, IC: 0, f: 1e6, TA: 25 } }],
      ICBO: [
        { max: 0.01e-6, unit: 'A', conditions: { VCB: 60, IE: 0, TA: 25 } },
        { max: 10e-6, unit: 'A', conditions: { VCB: 60, IE: 0, TA: 150 } },
      ],
    },
    notes: [
      'Data is for the onsemi P2N2222A (TO-92 Case 29 Style 17: 1 = collector, 2 = base, 3 = emitter). Metal-can TO-18 2N2222A parts (other vendors) use a different lead order and dissipation ratings.',
      'No SPICE model: onsemi publishes none for P2N2222A (part is obsolete at onsemi) and stock LTspice standard.bjt only has 2N2222 (not the A version).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'TIP120',
    aliases: ['TIP120G'],
    category: 'bjt',
    polarity: 'NPN',
    darlington: true,
    manufacturer: 'onsemi',
    description: 'NPN Darlington power transistor, 60 V / 5 A, 65 W, built-in base-emitter shunt resistors',
    package: { name: 'TO-220AB', pinCount: 4 },
    pins: [
      { number: 1, name: 'B', function: 'Base' },
      { number: 2, name: 'C', function: 'Collector' },
      { number: 3, name: 'E', function: 'Emitter' },
      { number: 4, name: 'C', function: 'Collector (mounting tab)' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'TIP120, TIP121, TIP122 (NPN); TIP125, TIP126, TIP127 (PNP) Plastic Medium-Power Complementary Silicon Transistors',
        document: 'TIP120/D',
        revision: 'Rev. 10, June 2024',
        url: 'https://www.onsemi.com/pdf/datasheet/tip120-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'onsemi',
        title: 'TIP120 PSpice Darlington macro model (MODPEX, Symmetry Design Systems)',
        document: 'TIP120.LIB',
        revision: 'Model generated on Dec 26, 2003',
        url: 'https://www.onsemi.com/pub/Collateral/TIP120.LIB',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'NPN',
      source: 'model',
      params: {
        Is: 3.29109e-14, Bf: 391.787, Nf: 0.894469, Vaf: 33.1384, Ikf: 0.198445, Ise: 1.21403e-10,
        Ne: 1.6375, Br: 0.1, Nr: 1.34795, Var: 135.277, Ikr: 0.137744, Isc: 1.01287e-13,
        Nc: 1.97483, Rb: 4.90772, Irb: 0.200762, Rbm: 4.90772, Re: 0.0826202, Rc: 0.413101,
        Xtb: 0.584577, Xti: 2.92564, Eg: 1.05, Cje: 2.09731e-10, Vje: 0.95, Mje: 0.23, Tf: 1e-9,
        Xtf: 1, Vtf: 10, Itf: 0.01, Cjc: 1.53283e-10, Vjc: 0.95, Mjc: 0.23, Xcjc: 0.9, Fc: 0.5,
        Tr: 1e-7, Ptf: 0, Kf: 0, Af: 1,
      },
      note: 'Inner device of the published .SUBCKT tip120 (nodes 1=C 2=B 3=E): this is "qmodel", the driver Q1 (Q1 1 2 4 qmodel). The output Q2 is "Q2 1 4 3 q1model 2.80758" (area 2.80758) with q1model identical to qmodel except CJC=0. Subckt also has R1 2 4 10000, R2 4 3 1000 and D1 3 1 (IS=1e-12 RS=10 N=1 XTI=3 CJO=0 VJ=0.75 M=0.33 FC=0.5). A single BJT with these params does not reproduce the Darlington; build the subcircuit.',
    },
    ratings: {
      Vceo: { max: 60, unit: 'V' },
      Vcbo: { max: 60, unit: 'V' },
      Vebo: { max: 5.0, unit: 'V' },
      IcMax: { max: 5.0, unit: 'A' },
      IcPeak: { max: 8.0, unit: 'A' },
      IbMax: { max: 0.12, unit: 'A' },
      Pd: { max: 2.0, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 65, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      hFE: [
        { min: 1000, unit: '1', conditions: { IC: 0.5, VCE: 3.0, TC: 25 } },
        { min: 1000, unit: '1', conditions: { IC: 3.0, VCE: 3.0, TC: 25 } },
        { typ: 2500, unit: '1', conditions: { IC: 4.0 } },
      ],
      VCEsat: [
        { max: 2.0, unit: 'V', conditions: { IC: 3.0, IB: 12e-3, TC: 25 } },
        { max: 4.0, unit: 'V', conditions: { IC: 5.0, IB: 20e-3, TC: 25 } },
      ],
      VBEon: [{ max: 2.5, unit: 'V', conditions: { IC: 3.0, VCE: 3.0, TC: 25 } }],
      fT: [
        {
          min: 4e6,
          unit: 'Hz',
          conditions: { IC: 3.0, VCE: 4.0, TC: 25 },
          estimated: true,
          note: 'Derived: fT ≈ |hfe|·f = 4.0 (min small-signal gain) × 1.0 MHz test frequency; datasheet prints |hfe| ≥ 4.0 at IC = 3 A, VCE = 4 V, f = 1 MHz, not fT.',
        },
      ],
      Cob: [{ max: 200e-12, unit: 'F', conditions: { VCB: 10, IE: 0, f: 0.1e6, TC: 25 } }],
      ICBO: [{ max: 0.2e-3, unit: 'A', conditions: { VCB: 60, IE: 0, TC: 25 } }],
    },
    notes: [
      'TO-220AB Case 221A Style 1: 1 = base, 2 = collector, 3 = emitter, 4 = collector (tab).',
      'Datasheet equivalent circuit (Fig. 1): base–emitter shunt resistors ≈ 8.0 kΩ (driver B–E) and ≈ 120 Ω (output B–E); the onsemi macro model instead uses 10 kΩ and 1 kΩ plus a C–E diode.',
      'hFE typ 2500 at IC = 4 A is from the Features list (no VCE stated). Electrical characteristics at TC = 25 °C.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'BD139',
    aliases: ['BD139G'],
    category: 'bjt',
    polarity: 'NPN',
    manufacturer: 'onsemi',
    description: 'NPN medium-power transistor, 80 V / 1.5 A, 12.5 W (complement BD140)',
    package: { name: 'TO-225', pinCount: 4 },
    pins: [
      { number: 1, name: 'E', function: 'Emitter' },
      { number: 2, name: 'C', function: 'Collector' },
      { number: 3, name: 'B', function: 'Base' },
      { number: 4, name: 'C', function: 'Collector (mounting surface)' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'BD135G, BD137G, BD139G Plastic Medium-Power Silicon NPN Transistors',
        document: 'BD135/D',
        revision: 'Rev. 18, June 2024',
        url: 'https://www.onsemi.com/pdf/datasheet/bd135-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'model',
        kind: 'spice-model',
        publisher: 'onsemi',
        title: 'BD139 PSpice model (MODPEX, Symmetry Design Systems)',
        document: 'BD139.LIB',
        revision: 'Model generated on Feb 14, 2004',
        url: 'https://www.onsemi.com/pub/Collateral/BD139.LIB',
        accessed: ACCESSED,
      },
    ],
    model: {
      type: 'NPN',
      source: 'model',
      params: {
        Is: 1e-9, Bf: 222.664, Nf: 0.85, Vaf: 36.4079, Ikf: 0.166126, Ise: 5.03418e-9,
        Ne: 1.45313, Br: 1.35467, Nr: 1.33751, Var: 142.931, Ikr: 1.66126, Isc: 5.02557e-9,
        Nc: 3.10227, Rb: 26.9143, Irb: 0.1, Rbm: 0.1, Re: 0.000472454, Rc: 1.04109,
        Xtb: 0.727762, Xti: 1.04311, Eg: 1.05, Cje: 1e-11, Vje: 0.75, Mje: 0.33,
        Tf: 1e-9, Xtf: 1, Vtf: 10, Itf: 0.01, Cjc: 1e-11, Vjc: 0.75, Mjc: 0.33, Xcjc: 0.9,
        Fc: 0.5, Cjs: 0, Vjs: 0.75, Mjs: 0.5, Tr: 1e-7, Ptf: 0, Kf: 0, Af: 1,
      },
    },
    ratings: {
      Vceo: { max: 80, unit: 'V' },
      Vcbo: { max: 100, unit: 'V' },
      Vebo: { max: 5.0, unit: 'V' },
      IcMax: { max: 1.5, unit: 'A' },
      IbMax: { max: 0.5, unit: 'A' },
      Pd: { max: 1.25, unit: 'W', conditions: { TA: 25 } },
      PdCase: { max: 12.5, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      hFE: [
        { min: 25, unit: '1', conditions: { IC: 5e-3, VCE: 2, TC: 25 } },
        { min: 40, max: 250, unit: '1', conditions: { IC: 0.15, VCE: 2, TC: 25 } },
        { min: 25, unit: '1', conditions: { IC: 0.5, VCE: 2, TC: 25 } },
      ],
      VCEsat: [{ max: 0.5, unit: 'V', conditions: { IC: 0.5, IB: 0.05, TC: 25 } }],
      VBEon: [{ max: 1, unit: 'V', conditions: { IC: 0.5, VCE: 2.0, TC: 25 } }],
      ICBO: [
        { max: 0.1e-6, unit: 'A', conditions: { VCB: 30, IE: 0, TC: 25 } },
        { max: 10e-6, unit: 'A', conditions: { VCB: 30, IE: 0, TC: 125 } },
      ],
    },
    notes: [
      'TO-225 Case 77-09 Style 1: 1 = emitter, 2 = collector, 3 = base; collector also on 4 (metal mounting surface). Lead order differs from TO-220 parts.',
      'onsemi datasheet gives no fT or capacitances for BD139. Electrical characteristics at TC = 25 °C.',
    ],
  },
];
