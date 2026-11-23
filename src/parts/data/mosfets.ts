import type { MosfetPart } from '../types';

/**
 * MOSFETs. Primary source of every part = its first citation (manufacturer datasheet).
 *
 * SPICE cards: vendors publish subcircuits / Level-3 / BSIM / VDMOS models, not Level-1, so every
 * `model` here is a FITTED Level-1 card (lumped W = L = 1, see MosfetModelParams), whole card
 * `estimated: true`. Common method (per-part inputs in each note):
 *  1. Two (VGS, ID) points read off the datasheet transfer-characteristic figure (TJ = 25 °C curve,
 *     saturation), P2 ≈ the continuous rating / RdsOn test current, P1 ≈ P2/2…P2/5 (square-law region).
 *     sqrt(ID) linear in VGS: Vto = (Vg1·√I2 − Vg2·√I1)/(√I2 − √I1), Kp = 2·((√I2 − √I1)/(Vg2 − Vg1))².
 *     Vector figures were read from the PDF path coordinates; raster figures from pixel positions.
 *  2. Rch = 1/(Kp·(VGS − Vto)) at the RdsOn test condition; remainder = RdsOn(typ, else max) − Rch is put
 *     100 % in Rd, Rs = 0: the transfer curve was measured at the terminals (it already contains the
 *     source resistance), so a non-zero Rs would degenerate the fitted saturation current; Rd does not.
 *  3. Lambda from the output-characteristic slope where readable, else omitted.
 *  4. Cgdo ≈ Crss, Cgso ≈ Ciss − Crss, Cbd ≈ Coss − Crss at the datasheet VDS (real values are
 *     strongly voltage dependent).
 * Body diode (`bodyDiode`): 'D' card with Is/N fitted from two points of the source-drain diode figure
 * (Vt = kT/q = 25.69 mV at 25 °C), Rs from a third high-current point: Rs = (V3 − N·Vt·ln(I3/Is))/I3.
 *
 * P-channel parts: ratings, characteristic values and test conditions are stored as magnitudes
 * (the datasheet prints them negative); SPICE params keep their true signs (Vto < 0).
 */

const ACCESSED = '2026-11-23';

export const MOSFETS: MosfetPart[] = [
  // -------------------------------------------------------------------------
  {
    id: '2N7000',
    category: 'mosfet',
    channel: 'N',
    manufacturer: 'onsemi',
    description: 'N-channel enhancement small-signal MOSFET, 60 V / 200 mA, TO-92',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'S', function: 'Source' },
      { number: 2, name: 'G', function: 'Gate' },
      { number: 3, name: 'D', function: 'Drain' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: '2N7000, 2N7002, NDS7002A N-Channel Enhancement Mode Field Effect Transistor',
        document: 'NDS7002A/D',
        revision: 'Rev. 11, March 2025',
        url: 'https://www.onsemi.com/download/data-sheet/pdf/nds7002a-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'alt',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: '2N7000G Small Signal MOSFET 200 mAmps, 60 Volts',
        document: '2N7000/D',
        revision: 'Rev. 8, April 2011',
        url: 'https://www.onsemi.com/download/data-sheet/pdf/2n7000-d.pdf',
        accessed: ACCESSED,
        note: 'Older (Motorola-lineage) onsemi 2N7000G sheet, min/max only (PD 350 mW, same pinout). Not used for values.',
      },
    ],
    ratings: {
      Vds: { max: 60, unit: 'V' },
      Vgs: { max: 20, unit: 'V', note: '±20 V continuous; ±40 V non-repetitive (tp < 50 µs)' },
      Id25: { max: 0.2, unit: 'A', conditions: { TC: 25 } },
      IdPulsed: { max: 0.5, unit: 'A' },
      Pd: { max: 0.4, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      RdsOn: [
        { typ: 1.2, max: 5, unit: 'Ω', conditions: { VGS: 10, ID: 0.5 } },
        { typ: 1.9, max: 9, unit: 'Ω', conditions: { VGS: 10, ID: 0.5, TC: 125 } },
        { typ: 1.8, max: 5.3, unit: 'Ω', conditions: { VGS: 4.5, ID: 0.075 } },
      ],
      VgsTh: { min: 0.8, typ: 2.1, max: 3, unit: 'V', conditions: { VDS: 'VGS', ID: 1e-3 } },
      gfs: [{ min: 0.1, typ: 0.32, unit: 'S', conditions: { VDS: 10, ID: 0.2 } }],
      Ciss: { typ: 20e-12, max: 50e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Coss: { typ: 11e-12, max: 25e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Crss: { typ: 4e-12, max: 5e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      transferPoints: [
        {
          typ: 0.1,
          unit: 'A',
          conditions: { VGS: 2.966, VDS: 10, TJ: 25 },
          estimated: true,
          note: 'Read from Fig. 5 (Transfer Characteristics, VDS = 10 V, 25 °C curve, vector path)',
        },
        {
          typ: 0.5,
          unit: 'A',
          conditions: { VGS: 4.428, VDS: 10, TJ: 25 },
          estimated: true,
          note: 'Read from Fig. 5 (Transfer Characteristics, VDS = 10 V, 25 °C curve, vector path)',
        },
      ],
    },
    model: {
      type: 'NMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: 1.78,
        Kp: 0.143,
        Lambda: 0.012,
        Rd: 0.349,
        Rs: 0,
        Cgdo: 4e-12,
        Cgso: 16e-12,
        Cbd: 7e-12,
      },
      note:
        'Fitted Level-1 (W=L=1). Transfer points Fig. 5 (VDS=10 V, 25 °C): (2.966 V, 0.10 A), (4.428 V, 0.50 A) → ' +
        'Vto=1.783 V (VGS(th) 0.8/2.1/3 V), Kp=0.1430 A/V². Rch=1/(Kp·(10−Vto))=0.851 Ω; RdsOn typ 1.2 Ω @10 V/0.5 A → ' +
        'Rd=0.349 Ω, Rs=0 (remainder 100 % in Rd). Lambda=0.012 1/V from Fig. 1, VGS=4 V curve between VDS=1.75 V and 5 V. ' +
        'Cgdo=Crss 4 pF, Cgso=Ciss−Crss 16 pF, Cbd=Coss−Crss 7 pF (typ @VDS=25 V). Check: model RdsOn @4.5 V = 2.9 Ω vs 1.8 Ω typ ' +
        '(Level-1 cannot match both gate drives).',
    },
    bodyDiode: {
      type: 'D',
      source: 'ds',
      estimated: true,
      params: { Is: 4.4e-13, N: 1.14, Rs: 0.125 },
      note:
        'Fitted from Fig. 8 (Body Diode Forward Voltage, 25 °C curve, vector path): (0.630 V, 1 mA), (0.701 V, 11.2 mA) → ' +
        'N=1.138, Is=4.40e-13 A; Rs from (1.073 V, 1.79 A) = 0.125 Ω. VSD is not specified for 2N7000 in the table ' +
        '(only for 2N7002/NDS7002A: 0.88 V typ).',
    },
    notes: [
      'Vendor model: onsemi lists simulation models at https://www.onsemi.com/design/resources/design-resources/models?rpn=2N7000 (file not retrieved/verified).',
      'Switching: ton/toff max 10 ns (VDD=15 V, RL=25 Ω, ID=500 mA, VGS=10 V, RGEN=25 Ω).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'BS170',
    category: 'mosfet',
    channel: 'N',
    manufacturer: 'onsemi',
    description: 'N-channel small-signal MOSFET, 60 V / 500 mA, TO-92',
    package: { name: 'TO-92', pinCount: 3 },
    pins: [
      { number: 1, name: 'D', function: 'Drain' },
      { number: 2, name: 'G', function: 'Gate' },
      { number: 3, name: 'S', function: 'Source' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'BS170 Small Signal MOSFET 500 mA, 60 Volts N-Channel TO-92',
        document: 'BS170/D',
        revision: 'Rev. 7, November 2017',
        url: 'https://www.onsemi.com/download/data-sheet/pdf/bs170-d.pdf',
        accessed: ACCESSED,
      },
      {
        id: 'fs',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'BS170, MMBF170 Field Effect Transistor - N-Channel, Enhancement Mode',
        document: 'MMBF170/D',
        revision: 'Rev. 9, February 2026',
        url: 'https://www.onsemi.com/download/data-sheet/pdf/mmbf170-d.pdf',
        accessed: ACCESSED,
        note: 'Fairchild-lineage onsemi BS170 sheet (pinout D-G-S as well); used for IdPulsed and the body-diode curve only.',
      },
    ],
    ratings: {
      Vds: { max: 60, unit: 'V' },
      Vgs: { max: 20, unit: 'V', note: '±20 V continuous; ±40 V non-repetitive (tp ≤ 50 µs)' },
      Id25: { max: 0.5, unit: 'A', conditions: { TA: 25 } },
      IdPulsed: { max: 1.2, unit: 'A', source: 'fs' },
      Pd: { max: 0.35, unit: 'W', conditions: { TA: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      RdsOn: [{ typ: 1.8, max: 5, unit: 'Ω', conditions: { VGS: 10, ID: 0.2 } }],
      VgsTh: { min: 0.8, typ: 2.0, max: 3.0, unit: 'V', conditions: { VDS: 'VGS', ID: 1e-3 } },
      gfs: [{ typ: 0.2, unit: 'S', conditions: { VDS: 10, ID: 0.25 } }],
      Ciss: { max: 60e-12, unit: 'F', conditions: { VDS: 10, VGS: 0, f: 1e6 } },
      Coss: {
        typ: 32e-12,
        unit: 'F',
        conditions: { VDS: 10, VGS: 0, f: 1e6 },
        estimated: true,
        note: 'Read from Fig. 6 (Capacitance vs VDS) at VDS = 10 V (vector path): 31.9 pF',
      },
      Crss: {
        typ: 4.3e-12,
        unit: 'F',
        conditions: { VDS: 10, VGS: 0, f: 1e6 },
        estimated: true,
        note: 'Read from Fig. 6 (Capacitance vs VDS) at VDS = 10 V (vector path)',
      },
      transferPoints: [
        {
          typ: 0.122,
          unit: 'A',
          conditions: { VGS: 4, VDS: 20, TA: 25 },
          estimated: true,
          note: 'No transfer figure in BS170/D: read from Fig. 5 (Output Characteristics) VGS = 4 V curve at VDS = 20 V (vector path)',
        },
        {
          typ: 0.58,
          unit: 'A',
          conditions: { VGS: 6, VDS: 20, TA: 25 },
          estimated: true,
          note: 'No transfer figure in BS170/D: read from Fig. 5 (Output Characteristics) VGS = 6 V curve at VDS = 20 V (vector path)',
        },
      ],
    },
    model: {
      type: 'NMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: 2.31,
        Kp: 0.085,
        Rd: 0.271,
        Rs: 0,
        Cgdo: 4.3e-12,
        Cgso: 29.8e-12,
        Cbd: 27.6e-12,
      },
      note:
        'Fitted Level-1 (W=L=1). Points from Fig. 5 (output char., VDS=20 V, TA=25 °C): (4 V, 0.122 A), (6 V, 0.580 A) → ' +
        'Vto=2.306 V (VGS(th) 0.8/2.0/3.0 V), Kp=0.0850 A/V² (5/7/8 V curves fall below square law). ' +
        'Rch=1/(Kp·(10−Vto))=1.529 Ω; RdsOn typ 1.8 Ω @10 V/0.2 A → Rd=0.271 Ω, Rs=0 (remainder 100 % in Rd). ' +
        'Lambda omitted: Fig. 5 curves flat within drawing resolution (< 1e-3 1/V). Caps from Fig. 6 at VDS=10 V: ' +
        'Ciss≈34.1 pF, Coss≈31.9 pF, Crss≈4.3 pF → Cgdo=4.3 pF, Cgso=29.8 pF, Cbd=27.6 pF.',
    },
    bodyDiode: {
      type: 'D',
      source: 'fs',
      estimated: true,
      params: { Is: 5.3e-13, N: 1.13, Rs: 0.126 },
      note:
        'BS170/D has no body-diode data; fitted from MMBF170/D Fig. 8 (25 °C curve, raster pixels): (0.622 V, 1.13 mA), ' +
        '(0.696 V, 14.6 mA) → N=1.127, Is=5.30e-13 A; Rs from (1.014 V, 1.47 A) = 0.126 Ω.',
    },
    notes: [
      'onsemi publishes two BS170 sheets: BS170/D (used here) and MMBF170/D (Fairchild lineage: RdsOn 1.2/5 Ω, Ciss/Coss/Crss typ 24/17/7 pF @10 V, PD 830 mW).',
      'Vendor model: onsemi lists simulation models at https://www.onsemi.com/design/resources/design-resources/models?rpn=BS170 (file not retrieved/verified).',
      'Switching: ton/toff typ 4 ns, max 10 ns (ID = 0.2 A, BS170/D Fig. 1 circuit).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'IRLZ44N',
    aliases: ['IRLZ44NPBF'],
    category: 'mosfet',
    channel: 'N',
    manufacturer: 'Infineon (International Rectifier)',
    description: 'N-channel logic-level HEXFET power MOSFET, 55 V / 47 A, 22 mΩ, TO-220AB',
    package: { name: 'TO-220AB', pinCount: 3 },
    pins: [
      { number: 1, name: 'G', function: 'Gate' },
      { number: 2, name: 'D', function: 'Drain (also tab)' },
      { number: 3, name: 'S', function: 'Source' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Infineon Technologies (International Rectifier)',
        title: 'IRLZ44NPbF HEXFET Power MOSFET',
        document: 'PD-94831',
        revision: '11/11/03',
        url: 'https://www.infineon.com/dgdl/irlz44npbf.pdf?fileId=5546d462533600a40153567217c32725',
        accessed: ACCESSED,
      },
    ],
    ratings: {
      Vds: { max: 55, unit: 'V' },
      Vgs: { max: 16, unit: 'V' },
      Id25: { max: 47, unit: 'A', conditions: { TC: 25, VGS: 10 } },
      Id100: { max: 33, unit: 'A', conditions: { TC: 100, VGS: 10 } },
      IdPulsed: { max: 160, unit: 'A' },
      Pd: { max: 110, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 175, unit: '°C' },
    },
    characteristics: {
      RdsOn: [
        { max: 0.022, unit: 'Ω', conditions: { VGS: 10, ID: 25 } },
        { max: 0.025, unit: 'Ω', conditions: { VGS: 5, ID: 25 } },
        { max: 0.035, unit: 'Ω', conditions: { VGS: 4, ID: 21 } },
      ],
      VgsTh: { min: 1.0, max: 2.0, unit: 'V', conditions: { VDS: 'VGS', ID: 250e-6 } },
      gfs: [{ min: 21, unit: 'S', conditions: { VDS: 25, ID: 25 } }],
      Ciss: { typ: 1700e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Coss: { typ: 400e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Crss: { typ: 150e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Qg: { max: 48e-9, unit: 'C', conditions: { ID: 25, VDS: 44, VGS: 5 } },
      Qgs: { max: 8.6e-9, unit: 'C', conditions: { ID: 25, VDS: 44, VGS: 5 } },
      Qgd: { max: 25e-9, unit: 'C', conditions: { ID: 25, VDS: 44, VGS: 5 } },
      Vsd: { max: 1.3, unit: 'V', conditions: { IS: 25, VGS: 0, TJ: 25 } },
      trr: { typ: 80e-9, max: 120e-9, unit: 's', conditions: { IF: 25, didt: 100e6, TJ: 25 } },
      transferPoints: [
        {
          typ: 22.2,
          unit: 'A',
          conditions: { VGS: 3.108, VDS: 25, TJ: 25 },
          estimated: true,
          note: 'Read from Fig. 3 (Typical Transfer Characteristics, VDS = 25 V, 20 µs pulse, 25 °C curve, vector path)',
        },
        {
          typ: 42.95,
          unit: 'A',
          conditions: { VGS: 3.663, VDS: 25, TJ: 25 },
          estimated: true,
          note: 'Read from Fig. 3 (Typical Transfer Characteristics, VDS = 25 V, 20 µs pulse, 25 °C curve, vector path)',
        },
      ],
    },
    model: {
      type: 'NMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: 1.69,
        Kp: 22.0,
        Lambda: 0.0023,
        Rd: 0.0165,
        Rs: 0,
        Cgdo: 150e-12,
        Cgso: 1550e-12,
        Cbd: 250e-12,
      },
      note:
        'Fitted Level-1 (W=L=1). Transfer points Fig. 3 (VDS=25 V, 25 °C): (3.108 V, 22.2 A), (3.663 V, 42.95 A) → ' +
        'Vto=1.688 V (VGS(th) 1.0–2.0 V), Kp=22.03 A/V². Rch=1/(Kp·(10−Vto))=5.46 mΩ; no typ RdsOn, max 22 mΩ @10 V/25 A → ' +
        'Rd=16.5 mΩ, Rs=0 (remainder 100 % in Rd). Lambda≈0.0023 1/V: mean of Fig. 1 VGS=2.5 V (0.0029) and 3.0 V (0.0018) ' +
        'curves between VDS≈1.4 V and 25 V. Cgdo=Crss 150 pF, Cgso=Ciss−Crss 1550 pF, Cbd=Coss−Crss 250 pF (@VDS=25 V). ' +
        'Check: model RdsOn 30.3 mΩ @5 V (spec max 25), 36.2 mΩ @4 V (spec max 35).',
    },
    bodyDiode: {
      type: 'D',
      source: 'ds',
      estimated: true,
      params: { Is: 3.86e-13, N: 1, Rs: 0.0071 },
      note:
        'Fig. 7 (Source-Drain Diode Forward Voltage, 25 °C, vector path) starts at 10 A, so the curve is Rs-dominated and a free ' +
        'N fit is ill-conditioned (LSQ gave N=0.8). N=1 ASSUMED; from (0.867 V, 10.3 A) and (1.443 V, 83.8 A): ' +
        'Rs=7.1 mΩ, Is=3.86e-13 A. Gives ~0.99 V at 25 A (VSD max 1.3 V).',
    },
    notes: [
      'TO-220AB lead assignment (IR): 1 Gate, 2 Drain, 3 Source, tab (4) Drain.',
      'Vendor model: Infineon/IR HEXFET SPICE models are distributed via the Infineon product page simulation-model section (not retrieved/verified here).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'IRF540N',
    aliases: ['IRF540NPBF'],
    category: 'mosfet',
    channel: 'N',
    manufacturer: 'Infineon',
    description: 'N-channel HEXFET power MOSFET, 100 V / 33 A, 44 mΩ, TO-220',
    package: { name: 'TO-220AB', pinCount: 3 },
    pins: [
      { number: 1, name: 'G', function: 'Gate' },
      { number: 2, name: 'D', function: 'Drain (also tab)' },
      { number: 3, name: 'S', function: 'Source' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Infineon Technologies',
        title: 'IRF540NPbF HEXFET Power MOSFET',
        revision: 'Rev. 2.1, 2026-07-24',
        url: 'https://www.infineon.com/dgdl/irf540npbf.pdf?fileId=5546d462533600a4015355e39f0d19a1',
        accessed: ACCESSED,
      },
    ],
    ratings: {
      Vds: { max: 100, unit: 'V' },
      Vgs: { max: 20, unit: 'V' },
      Id25: { max: 33, unit: 'A', conditions: { TC: 25, VGS: 10 } },
      Id100: { max: 23, unit: 'A', conditions: { TC: 100, VGS: 10 } },
      IdPulsed: { max: 110, unit: 'A' },
      Pd: { max: 130, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 175, unit: '°C' },
    },
    characteristics: {
      RdsOn: [{ max: 0.044, unit: 'Ω', conditions: { VGS: 10, ID: 16 } }],
      VgsTh: { min: 2.0, max: 4.0, unit: 'V', conditions: { VDS: 'VGS', ID: 250e-6 } },
      gfs: [{ min: 21, unit: 'S', conditions: { VDS: 50, ID: 16 } }],
      Ciss: { typ: 1960e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Coss: { typ: 250e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Crss: { typ: 40e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Qg: { max: 71e-9, unit: 'C', conditions: { ID: 16, VDS: 80, VGS: 10 } },
      Qgs: { max: 14e-9, unit: 'C', conditions: { ID: 16, VDS: 80, VGS: 10 } },
      Qgd: { max: 21e-9, unit: 'C', conditions: { ID: 16, VDS: 80, VGS: 10 } },
      Vsd: { max: 1.2, unit: 'V', conditions: { IS: 16, VGS: 0, TJ: 25 } },
      trr: { typ: 115e-9, max: 170e-9, unit: 's', conditions: { IF: 16, didt: 100e6, TJ: 25 } },
      transferPoints: [
        {
          typ: 16.07,
          unit: 'A',
          conditions: { VGS: 4.669, VDS: 50, TJ: 25 },
          estimated: true,
          note: 'Read from Fig. 3 (Typical Transfer Characteristics, VDS = 50 V, 20 µs pulse, 25 °C curve, raster pixels)',
        },
        {
          typ: 33.7,
          unit: 'A',
          conditions: { VGS: 5.155, VDS: 50, TJ: 25 },
          estimated: true,
          note: 'Read from Fig. 3 (Typical Transfer Characteristics, VDS = 50 V, 20 µs pulse, 25 °C curve, raster pixels)',
        },
      ],
    },
    model: {
      type: 'NMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: 3.58,
        Kp: 27.3,
        Rd: 0.0383,
        Rs: 0,
        Cgdo: 40e-12,
        Cgso: 1920e-12,
        Cbd: 210e-12,
      },
      note:
        'Fitted Level-1 (W=L=1). Transfer points Fig. 3 (VDS=50 V, 25 °C): (4.669 V, 16.07 A), (5.155 V, 33.7 A) → ' +
        'Vto=3.585 V (VGS(th) 2.0–4.0 V), Kp=27.33 A/V². Rch=1/(Kp·(10−Vto))=5.70 mΩ; no typ RdsOn, max 44 mΩ @10 V/16 A → ' +
        'Rd=38.3 mΩ, Rs=0 (remainder 100 % in Rd). Above ~60 A the real transfer curve flattens (model over-predicts, ' +
        '~90 A vs 70 A read at 6.16 V). Lambda omitted (raster log-log output curves). Cgdo=Crss 40 pF, Cgso=Ciss−Crss 1920 pF, ' +
        'Cbd=Coss−Crss 210 pF (@VDS=25 V).',
    },
    bodyDiode: {
      type: 'D',
      source: 'ds',
      estimated: true,
      params: { Is: 1.26e-10, N: 1.25, Rs: 0.0064 },
      note:
        'Fitted from Fig. 7 (Typical Source-to-Drain Diode Forward Voltage, 25 °C, raster pixels): (0.661 V, 0.107 A), ' +
        '(0.743 V, 1.35 A) → N=1.252, Is=1.26e-10 A; Rs from (1.157 V, 47 A) = 6.4 mΩ. Gives ~0.93 V at 16 A (VSD max 1.2 V).',
    },
    notes: [
      'Pinout from datasheet p.1 symbol: Gate pin 1, Drain pin 2 + tab, Source pin 3.',
      'Vendor model: Infineon product page https://www.infineon.com/part/IRF540N lists design resources; a SPICE file was not retrieved/verified here.',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'IRF9540N',
    aliases: ['IRF9540NPBF'],
    category: 'mosfet',
    channel: 'P',
    manufacturer: 'Infineon (International Rectifier)',
    description: 'P-channel HEXFET power MOSFET, −100 V / −23 A, 117 mΩ, TO-220AB',
    package: { name: 'TO-220AB', pinCount: 3 },
    pins: [
      { number: 1, name: 'G', function: 'Gate' },
      { number: 2, name: 'D', function: 'Drain (also tab)' },
      { number: 3, name: 'S', function: 'Source' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Infineon Technologies (International Rectifier)',
        title: 'IRF9540NPbF HEXFET Power MOSFET',
        document: 'PD-94790A',
        revision: '01/23/04',
        url: 'https://www.infineon.com/dgdl/irf9540npbf.pdf?fileId=5546d462533600a4015355e3be0c19a7',
        accessed: ACCESSED,
        note: 'Scanned PDF (no text layer): values read from rendered pages.',
      },
    ],
    // P-channel: all Spec values and conditions below are magnitudes (datasheet prints them negative).
    ratings: {
      Vds: { max: 100, unit: 'V' }, // magnitude
      Vgs: { max: 20, unit: 'V' },
      Id25: { max: 23, unit: 'A', conditions: { TC: 25, VGS: 10 } }, // magnitude
      Id100: { max: 16, unit: 'A', conditions: { TC: 100, VGS: 10 } }, // magnitude
      IdPulsed: { max: 76, unit: 'A' }, // magnitude
      Pd: { max: 140, unit: 'W', conditions: { TC: 25 } },
      TjMax: { max: 175, unit: '°C' },
    },
    characteristics: {
      RdsOn: [{ max: 0.117, unit: 'Ω', conditions: { VGS: 10, ID: 11 } }], // magnitude conditions
      VgsTh: { min: 2.0, max: 4.0, unit: 'V', conditions: { VDS: 'VGS', ID: 250e-6 } }, // magnitude
      gfs: [{ min: 5.3, unit: 'S', conditions: { VDS: 50, ID: 11 } }], // magnitude conditions
      Ciss: { typ: 1300e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Coss: { typ: 400e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Crss: { typ: 240e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Qg: { max: 97e-9, unit: 'C', conditions: { ID: 11, VDS: 80, VGS: 10 } },
      Qgs: { max: 15e-9, unit: 'C', conditions: { ID: 11, VDS: 80, VGS: 10 } },
      Qgd: { max: 51e-9, unit: 'C', conditions: { ID: 11, VDS: 80, VGS: 10 } },
      Vsd: { max: 1.6, unit: 'V', conditions: { IS: 11, VGS: 0, TJ: 25 } }, // magnitude
      trr: { typ: 150e-9, max: 220e-9, unit: 's', conditions: { IF: 11, didt: 100e6, TJ: 25 } },
      transferPoints: [
        {
          typ: 10.2,
          unit: 'A',
          conditions: { VGS: 5.898, VDS: 25, TJ: 25 }, // magnitudes
          estimated: true,
          note: 'Read from Fig. 3 (Typical Transfer Characteristics, −VDS = 25 V, 20 µs pulse, 25 °C curve, raster pixels of a scan)',
        },
        {
          typ: 24.8,
          unit: 'A',
          conditions: { VGS: 7.336, VDS: 25, TJ: 25 }, // magnitudes
          estimated: true,
          note: 'Read from Fig. 3 (Typical Transfer Characteristics, −VDS = 25 V, 20 µs pulse, 25 °C curve, raster pixels of a scan)',
        },
      ],
    },
    model: {
      type: 'PMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: -3.33,
        Kp: 3.09,
        Rd: 0.0684,
        Rs: 0,
        Cgdo: 240e-12,
        Cgso: 1060e-12,
        Cbd: 160e-12,
      },
      note:
        'Fitted Level-1 (W=L=1), fit on |ID|,|VGS| then signed. Transfer points Fig. 3 (|VDS|=25 V, 25 °C): (5.898 V, 10.2 A), ' +
        '(7.336 V, 24.8 A) → |Vto|=3.327 V (|VGS(th)| 2.0–4.0 V) → Vto=−3.33 V, Kp=3.086 A/V². Rch=1/(Kp·(10−|Vto|))=48.6 mΩ; ' +
        'no typ RdsOn, max 117 mΩ @|VGS|=10 V/|ID|=11 A → Rd=68.4 mΩ, Rs=0 (remainder 100 % in Rd). Lambda omitted (scanned ' +
        'log-log output curves). Cgdo=Crss 240 pF, Cgso=Ciss−Crss 1060 pF, Cbd=Coss−Crss 160 pF (@|VDS|=25 V).',
    },
    bodyDiode: {
      type: 'D',
      source: 'ds',
      estimated: true,
      params: { Is: 1.4e-9, N: 1.42, Rs: 0.0077 },
      note:
        'Fitted from Fig. 7 (Typical Source-Drain Diode Forward Voltage, 25 °C, raster pixels of a scan): (0.665 V, 0.116 A), ' +
        '(0.758 V, 1.49 A) → N=1.419, Is=1.40e-9 A; Rs from (1.207 V, 42.7 A) = 7.7 mΩ. Gives ~0.92 V at 11 A (VSD max 1.6 V). ' +
        'Diode conducts drain→source (anode at drain) for this P-channel device.',
    },
    notes: [
      'P-channel: Spec values/conditions stored as magnitudes; SPICE Vto is negative.',
      'TO-220AB lead assignment (IR): 1 Gate, 2 Drain, 3 Source, tab (4) Drain.',
      'Vendor model: Infineon/IR HEXFET SPICE models via the Infineon product page (not retrieved/verified here).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'AO3400A',
    category: 'mosfet',
    channel: 'N',
    manufacturer: 'Alpha & Omega Semiconductor',
    description: 'N-channel trench MOSFET, 30 V / 5.7 A, 26.5 mΩ @10 V (logic level to 2.5 V), SOT-23',
    package: { name: 'SOT-23', pinCount: 3 },
    pins: [
      { number: 1, name: 'G', function: 'Gate' },
      { number: 2, name: 'S', function: 'Source' },
      { number: 3, name: 'D', function: 'Drain' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'Alpha & Omega Semiconductor',
        title: 'AO3400A 30V N-Channel MOSFET',
        revision: 'Rev 3.1, July 2023',
        url: 'https://www.aosmd.com/res/datasheets/AO3400A.pdf',
        accessed: ACCESSED,
      },
    ],
    ratings: {
      Vds: { max: 30, unit: 'V' },
      Vgs: { max: 12, unit: 'V' },
      Id25: { max: 5.7, unit: 'A', conditions: { TA: 25 } },
      IdPulsed: { max: 30, unit: 'A' },
      Pd: { max: 1.4, unit: 'W', conditions: { TA: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      RdsOn: [
        { typ: 0.018, max: 0.0265, unit: 'Ω', conditions: { VGS: 10, ID: 5.7 } },
        { typ: 0.028, max: 0.038, unit: 'Ω', conditions: { VGS: 10, ID: 5.7, TJ: 125 } },
        { typ: 0.019, max: 0.032, unit: 'Ω', conditions: { VGS: 4.5, ID: 5 } },
        { typ: 0.024, max: 0.048, unit: 'Ω', conditions: { VGS: 2.5, ID: 3 } },
      ],
      VgsTh: { min: 0.65, typ: 1.05, max: 1.45, unit: 'V', conditions: { VDS: 'VGS', ID: 250e-6 } },
      gfs: [{ typ: 33, unit: 'S', conditions: { VDS: 5, ID: 5.7 } }],
      Ciss: { typ: 630e-12, unit: 'F', conditions: { VDS: 15, VGS: 0, f: 1e6 } },
      Coss: { typ: 75e-12, unit: 'F', conditions: { VDS: 15, VGS: 0, f: 1e6 } },
      Crss: { typ: 50e-12, unit: 'F', conditions: { VDS: 15, VGS: 0, f: 1e6 } },
      Qg: { typ: 6e-9, max: 7e-9, unit: 'C', conditions: { VGS: 4.5, VDS: 15, ID: 5.7 } },
      Qgs: { typ: 1.3e-9, unit: 'C', conditions: { VGS: 4.5, VDS: 15, ID: 5.7 } },
      Qgd: { typ: 1.8e-9, unit: 'C', conditions: { VGS: 4.5, VDS: 15, ID: 5.7 } },
      Vsd: { typ: 0.7, max: 1, unit: 'V', conditions: { IS: 1, VGS: 0 } },
      trr: { typ: 8.5e-9, unit: 's', conditions: { IF: 5.7, didt: 100e6 } },
      transferPoints: [
        {
          typ: 2.007,
          unit: 'A',
          conditions: { VGS: 1.62, VDS: 5, TJ: 25 },
          estimated: true,
          note: 'Read from Figure 2 (Transfer Characteristics, VDS = 5 V, 25 °C curve, vector path)',
        },
        {
          typ: 5.998,
          unit: 'A',
          conditions: { VGS: 1.759, VDS: 5, TJ: 25 },
          estimated: true,
          note: 'Read from Figure 2 (Transfer Characteristics, VDS = 5 V, 25 °C curve, vector path)',
        },
      ],
    },
    model: {
      type: 'NMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: 1.43,
        Kp: 110,
        Lambda: 0.0054,
        Rd: 0.0169,
        Rs: 0,
        Rg: 3,
        Cgdo: 50e-12,
        Cgso: 580e-12,
        Cbd: 25e-12,
      },
      estimatedParams: { Rg: 'Not fitted: datasheet Rg typ 3 Ω (VGS=0, VDS=0, f=1 MHz; min 1.5, max 4.5).' },
      note:
        'Fitted Level-1 (W=L=1). Transfer points Figure 2 (VDS=5 V, 25 °C): (1.620 V, 2.007 A), (1.759 V, 5.998 A) → ' +
        'Vto=1.429 V (VGS(th) 0.65/1.05/1.45 V), Kp=110.3 A/V². Rch=1/(Kp·(10−Vto))=1.06 mΩ; RdsOn typ 18 mΩ @10 V/5.7 A → ' +
        'Rd=16.9 mΩ, Rs=0 (remainder 100 % in Rd). Lambda=0.0054 1/V from Fig. 1 VGS=2.5 V curve (VDS 2→5 V); the VGS=2 V ' +
        'curve gives 0.077 1/V. Cgdo=Crss 50 pF, Cgso=Ciss−Crss 580 pF, Cbd=Coss−Crss 25 pF (@VDS=15 V). ' +
        'Check: model RdsOn 19.9 mΩ @4.5 V (typ 19), 25.4 mΩ @2.5 V (typ 24).',
    },
    bodyDiode: {
      type: 'D',
      source: 'ds',
      estimated: true,
      params: { Is: 3.7e-12, N: 1.0, Rs: 0.018 },
      note:
        'Fitted from Figure 6 (Body-Diode Characteristics, 25 °C, vector path): (0.438 V, 100 µA), (0.556 V, 10 mA) → ' +
        'N=0.997, Is=3.71e-12 A; Rs from (0.804 V, 4.97 A) = 17.9 mΩ. Gives ~0.69 V at 1 A (VSD typ 0.7 V).',
    },
    notes: [
      'Pin numbers: datasheet shows the SOT-23 with the pin-1 dot at G (no numbers printed); standard SOT-23 numbering 1=G, 2=S, 3=D.',
      'Id at TA=70 °C: 4.7 A; PD at TA=70 °C: 0.9 W (no TC=100 °C rating given).',
      'Vendor model: no SPICE model found on the AOS product page (https://aosmd.com/products/mosfets/low-voltage-mosfets-12v-30v/ao3400a).',
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'BSS84',
    category: 'mosfet',
    channel: 'P',
    manufacturer: 'onsemi',
    description: 'P-channel enhancement small-signal MOSFET, −50 V / −130 mA, SOT-23',
    package: { name: 'SOT-23', pinCount: 3 },
    pins: [
      { number: 1, name: 'G', function: 'Gate' },
      { number: 2, name: 'S', function: 'Source' },
      { number: 3, name: 'D', function: 'Drain' },
    ],
    sources: [
      {
        id: 'ds',
        kind: 'datasheet',
        publisher: 'onsemi',
        title: 'BSS84 P-Channel Enhancement Mode Field-Effect Transistor',
        document: 'BSS84/D',
        revision: 'Rev. 5, October 2021',
        url: 'https://www.onsemi.com/download/data-sheet/pdf/bss84-d.pdf',
        accessed: ACCESSED,
      },
    ],
    // P-channel: all Spec values and conditions below are magnitudes (datasheet prints them negative).
    ratings: {
      Vds: { max: 50, unit: 'V' }, // magnitude
      Vgs: { max: 20, unit: 'V' },
      Id25: { max: 0.13, unit: 'A', conditions: { TA: 25 } }, // magnitude
      IdPulsed: { max: 0.52, unit: 'A' }, // magnitude
      Pd: { max: 0.36, unit: 'W', conditions: { TA: 25 } },
      TjMax: { max: 150, unit: '°C' },
    },
    characteristics: {
      RdsOn: [
        { typ: 1.2, max: 10, unit: 'Ω', conditions: { VGS: 5, ID: 0.1 } }, // magnitude conditions
        { typ: 1.9, max: 17, unit: 'Ω', conditions: { VGS: 5, ID: 0.1, TJ: 125 } },
      ],
      VgsTh: { min: 0.8, typ: 1.7, max: 2, unit: 'V', conditions: { VDS: 'VGS', ID: 1e-3 } }, // magnitude
      gfs: [{ min: 0.05, typ: 0.6, unit: 'S', conditions: { VDS: 25, ID: 0.1 } }],
      Ciss: { typ: 73e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Coss: { typ: 10e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Crss: { typ: 5e-12, unit: 'F', conditions: { VDS: 25, VGS: 0, f: 1e6 } },
      Qg: { typ: 0.9e-9, max: 1.3e-9, unit: 'C', conditions: { VDS: 25, ID: 0.1, VGS: 5 } },
      Qgs: { typ: 0.2e-9, unit: 'C', conditions: { VDS: 25, ID: 0.1, VGS: 5 } },
      Qgd: { typ: 0.3e-9, unit: 'C', conditions: { VDS: 25, ID: 0.1, VGS: 5 } },
      Vsd: { typ: 0.8, max: 1.2, unit: 'V', conditions: { IS: 0.26, VGS: 0 } }, // magnitude
      trr: { typ: 10e-9, unit: 's', conditions: { IF: 0.1, didt: 100e6 } },
      transferPoints: [
        {
          typ: 0.0328,
          unit: 'A',
          conditions: { VGS: 2.091, VDS: 5, TA: 25 }, // magnitudes
          estimated: true,
          note: 'Read from Figure 5 (Transfer Characteristics, −VDS = 5 V, TA = 25 °C curve, vector path)',
        },
        {
          typ: 0.1304,
          unit: 'A',
          conditions: { VGS: 2.357, VDS: 5, TA: 25 }, // magnitudes
          estimated: true,
          note: 'Read from Figure 5 (Transfer Characteristics, −VDS = 5 V, TA = 25 °C curve, vector path)',
        },
      ],
    },
    model: {
      type: 'PMOS',
      level: 1,
      source: 'ds',
      estimated: true,
      params: {
        Vto: -1.82,
        Kp: 0.921,
        Rd: 0.858,
        Rs: 0,
        Rg: 9,
        Cgdo: 5e-12,
        Cgso: 68e-12,
        Cbd: 5e-12,
      },
      estimatedParams: { Rg: 'Not fitted: datasheet RG typ 9 Ω (VGS = 15 mV, f = 1 MHz).' },
      note:
        'Fitted Level-1 (W=L=1), fit on |ID|,|VGS| then signed. Transfer points Figure 5 (|VDS|=5 V, 25 °C): ' +
        '(2.091 V, 32.8 mA), (2.357 V, 130.4 mA) → |Vto|=1.825 V (|VGS(th)| 0.8/1.7/2.0 V) → Vto=−1.82 V, Kp=0.921 A/V². ' +
        'Rch=1/(Kp·(5−|Vto|))=0.342 Ω at |VGS|=5 V; RdsOn typ 1.2 Ω @5 V/0.1 A → Rd=0.858 Ω, Rs=0 (remainder 100 % in Rd). ' +
        'Above ~0.5 A the model over-predicts (1.25 A vs 1.0 A read at 3.47 V). Lambda omitted. Cgdo=Crss 5 pF, ' +
        'Cgso=Ciss−Crss 68 pF, Cbd=Coss−Crss 5 pF (@|VDS|=25 V).',
    },
    bodyDiode: {
      type: 'D',
      source: 'ds',
      estimated: true,
      params: { Is: 2.06e-12, N: 1.17, Rs: 0.194 },
      note:
        'Fitted from Figure 6 (Body Diode Forward Voltage, 25 °C, vector path): (0.537 V, 0.116 mA), (0.668 V, 9.22 mA) → ' +
        'N=1.170, Is=2.06e-12 A; Rs from (0.911 V, 0.601 A) = 0.194 Ω. Gives ~0.82 V at 0.26 A (VSD typ 0.8 V). ' +
        'Diode conducts drain→source (anode at drain) for this P-channel device.',
    },
    notes: [
      'P-channel: Spec values/conditions stored as magnitudes; SPICE Vto is negative.',
      'Vendor model: onsemi lists simulation models at https://www.onsemi.com/design/resources/design-resources/models?rpn=BSS84 (not retrieved/verified); Diodes Inc. publishes a BSS84 SPICE model for its own BSS84.',
    ],
  },
];
