/**
 * Logic ICs (74HC / 74HCT / CD4000B) — DIP package pinouts, TA = 25 °C data.
 *
 * Pin-name convention: a leading '~' marks an active-low / complemented pin
 * (overbar in the datasheet), e.g. '~OE', '~1Q'.
 */
import type { Citation, LogicLevelPoint, LogicPart, Spec } from "../types";

const ACCESSED = "2026-11-23";

function tiDs(
  part: string,
  document: string,
  revision: string,
  title: string,
): Citation {
  return {
    id: "ds",
    kind: "datasheet",
    publisher: "Texas Instruments",
    title,
    document,
    revision,
    url: `https://www.ti.com/lit/ds/symlink/${part}.pdf`,
    accessed: ACCESSED,
  };
}

// ---------------------------------------------------------------------------
// Shared 74HC helpers. Every value below was read in EACH part's own TI datasheet
// (SN74HC00/04/14/74 print identical DC output tables for their standard outputs);
// they are factored out only to avoid copy errors.

const T25 = { TA: 25 } as const;

/** HC VIH min / VIL max (Recommended Operating Conditions), non-Schmitt inputs. */
function hcInputLevels(vcc: 2 | 4.5 | 6): Pick<LogicLevelPoint, "VIH" | "VIL"> {
  const vih = { 2: 1.5, 4.5: 3.15, 6: 4.2 }[vcc];
  const vil = { 2: 0.5, 4.5: 1.35, 6: 1.8 }[vcc];
  return {
    VIH: { min: vih, unit: "V", conditions: { VCC: vcc } },
    VIL: { max: vil, unit: "V", conditions: { VCC: vcc } },
  };
}

/** Output resistance estimate from a VOH/VOL row (see notes). */
function rOut(
  kind: "low" | "high",
  vcc: number,
  io: number,
  vTyp: number,
  vWorst: number,
): Spec {
  const typ = kind === "low" ? vTyp / io : (vcc - vTyp) / io;
  const max = kind === "low" ? vWorst / io : (vcc - vWorst) / io;
  const r3 = (x: number) => Number(x.toPrecision(3));
  const ma = io * 1e3;
  const formula =
    kind === "low"
      ? `rOutLow = VOL/IOL at IOL = ${ma} mA, VCC = ${vcc} V, TA = 25 °C: typ ${vTyp} V/${ma} mA; max uses guaranteed VOL max ${vWorst} V (worst-case bound)`
      : `rOutHigh = (VCC − VOH)/|IOH| at |IOH| = ${ma} mA, VCC = ${vcc} V, TA = 25 °C: typ (${vcc} − ${vTyp}) V/${ma} mA; max uses guaranteed VOH min ${vWorst} V (worst-case bound)`;
  return {
    typ: r3(typ),
    max: r3(max),
    unit: "Ω",
    conditions: { VCC: vcc, IO: kind === "low" ? io : -io, TA: 25 },
    estimated: true,
    note: `Estimated (not printed). ${formula}.`,
  };
}

/** HC standard-output VOH/VOL (IOH −4 mA @ 4.5 V, −5.2 mA @ 6 V) + derived rOut. */
function hcStdOutputs(
  vcc: 2 | 4.5 | 6,
): Pick<LogicLevelPoint, "VOH" | "VOL" | "rOutHigh" | "rOutLow"> {
  if (vcc === 2) {
    return {
      VOH: [
        {
          min: 1.9,
          typ: 1.998,
          unit: "V",
          conditions: { VCC: 2, IO: -20e-6, ...T25 },
        },
      ],
      VOL: [
        {
          typ: 0.002,
          max: 0.1,
          unit: "V",
          conditions: { VCC: 2, IO: 20e-6, ...T25 },
        },
      ],
    };
  }
  if (vcc === 4.5) {
    return {
      VOH: [
        {
          min: 4.4,
          typ: 4.499,
          unit: "V",
          conditions: { VCC: 4.5, IO: -20e-6, ...T25 },
        },
        {
          min: 3.98,
          typ: 4.3,
          unit: "V",
          conditions: { VCC: 4.5, IO: -0.004, ...T25 },
        },
      ],
      VOL: [
        {
          typ: 0.001,
          max: 0.1,
          unit: "V",
          conditions: { VCC: 4.5, IO: 20e-6, ...T25 },
        },
        {
          typ: 0.17,
          max: 0.26,
          unit: "V",
          conditions: { VCC: 4.5, IO: 0.004, ...T25 },
        },
      ],
      rOutHigh: rOut("high", 4.5, 0.004, 4.3, 3.98),
      rOutLow: rOut("low", 4.5, 0.004, 0.17, 0.26),
    };
  }
  return {
    VOH: [
      {
        min: 5.9,
        typ: 5.999,
        unit: "V",
        conditions: { VCC: 6, IO: -20e-6, ...T25 },
      },
      {
        min: 5.48,
        typ: 5.8,
        unit: "V",
        conditions: { VCC: 6, IO: -0.0052, ...T25 },
      },
    ],
    VOL: [
      {
        typ: 0.001,
        max: 0.1,
        unit: "V",
        conditions: { VCC: 6, IO: 20e-6, ...T25 },
      },
      {
        typ: 0.15,
        max: 0.26,
        unit: "V",
        conditions: { VCC: 6, IO: 0.0052, ...T25 },
      },
    ],
    rOutHigh: rOut("high", 6, 0.0052, 5.8, 5.48),
    rOutLow: rOut("low", 6, 0.0052, 0.15, 0.26),
  };
}

/** tpd Spec helper (ns in, s out). */
function tpd(
  vcc: number,
  typNs: number,
  maxNs: number,
  path: string,
  cl?: number,
  extra: Record<string, string | number> = {},
): Spec {
  // CD4000 callers pass VDD in `extra`; then the supply key is VDD instead of VCC.
  const supply: Record<string, number> = "VDD" in extra ? {} : { VCC: vcc };
  const conditions: Record<string, string | number> = {
    ...supply,
    path,
    ...T25,
    ...extra,
  };
  if (cl !== undefined) conditions.CL = cl;
  return { typ: typNs / 1e9, max: maxNs / 1e9, unit: "s", conditions };
}

/** HC absolute-maximum ratings common to standard-output TI HC parts. */
function hcRatings(io = 0.025, iSupply = 0.05): LogicPart["ratings"] {
  return {
    vccMax: { max: 7, unit: "V" },
    vccMin: { min: -0.5, unit: "V" },
    inputClampCurrent: { max: 0.02, unit: "A" }, // magnitude (±20 mA)
    outputClampCurrent: { max: 0.02, unit: "A" }, // magnitude (±20 mA)
    outputCurrentPerPin: { max: io, unit: "A", conditions: { VO: "0 to VCC" } }, // magnitude
    supplyPinCurrent: { max: iSupply, unit: "A" }, // magnitude
    TjMax: { max: 150, unit: "°C" },
  };
}

/** HC recommended: VCC 2–6 V (nom 5); optional max input transition time 1000/500/400 ns. */
function hcRecommended(withTransition: boolean): LogicPart["recommended"] {
  return {
    vcc: { min: 2, typ: 5, max: 6, unit: "V" },
    ...(withTransition
      ? {
          inputTransitionTime: [
            { max: 1000e-9, unit: "s", conditions: { VCC: 2 } },
            { max: 500e-9, unit: "s", conditions: { VCC: 4.5 } },
            { max: 400e-9, unit: "s", conditions: { VCC: 6 } },
          ] satisfies Spec[],
        }
      : {}),
  };
}

const hcIcc = (maxA: number): Spec => ({
  max: maxA,
  unit: "A",
  conditions: { VCC: 6, VI: "VCC or 0", IO: 0, ...T25 },
});

const DIP14 = { name: "DIP-14", pinCount: 14 };
const DIP16 = { name: "DIP-16", pinCount: 16 };

// ---------------------------------------------------------------------------
// CD4000B helpers (identical B-series static table printed in SCHS021D and SCHS027C)

type CdV = 5 | 10 | 15;

function cdStatic(
  vdd: CdV,
  iddMax: number,
  iddTyp: number,
  vilVo: string,
): Pick<
  LogicLevelPoint,
  "VIH" | "VIL" | "VOH" | "VOL" | "IOL" | "IOH" | "rOutLow" | "rOutHigh" | "icc"
> {
  const vih = { 5: 3.5, 10: 7, 15: 11 }[vdd];
  const vil = { 5: 1.5, 10: 3, 15: 4 }[vdd];
  const vihVo = { 5: "0.5 or 4.5", 10: "1 or 9", 15: "1.5 or 13.5" }[vdd];
  const vin = `0 or ${vdd}`;
  // IOL min/typ at VO; IOH (magnitude) min/typ at VO — 25 °C columns.
  const iol = {
    5: [0.4, 0.51e-3, 1e-3],
    10: [0.5, 1.3e-3, 2.6e-3],
    15: [1.5, 3.4e-3, 6.8e-3],
  }[vdd];
  const ioh: number[][] = {
    5: [
      [4.6, 0.51e-3, 1e-3],
      [2.5, 1.6e-3, 3.2e-3],
    ],
    10: [[9.5, 1.3e-3, 2.6e-3]],
    15: [[13.5, 3.4e-3, 6.8e-3]],
  }[vdd];
  const r3 = (x: number) => Number(x.toPrecision(3));
  const [voL, iolMin, iolTyp] = iol;
  const [voH, iohMin, iohTyp] = ioh[0];
  const dropH = Number((vdd - voH).toFixed(2));
  return {
    VIH: { min: vih, unit: "V", conditions: { VDD: vdd, VO: vihVo, ...T25 } },
    VIL: { max: vil, unit: "V", conditions: { VDD: vdd, VO: vilVo, ...T25 } },
    VOH: [
      {
        min: vdd - 0.05,
        typ: vdd,
        unit: "V",
        conditions: { VDD: vdd, VIN: vin, load: "none (no IO stated)", ...T25 },
      },
    ],
    VOL: [
      {
        typ: 0,
        max: 0.05,
        unit: "V",
        conditions: { VDD: vdd, VIN: vin, load: "none (no IO stated)", ...T25 },
      },
    ],
    IOL: [
      {
        min: iolMin,
        typ: iolTyp,
        unit: "A",
        conditions: { VDD: vdd, VO: voL, VIN: vin, ...T25 },
      },
    ],
    // magnitude: source current (datasheet prints IOH as negative values)
    IOH: ioh.map(([vo, mn, ty]) => ({
      min: mn,
      typ: ty,
      unit: "A" as const,
      conditions: { VDD: vdd, VO: vo, VIN: vin, ...T25 },
    })),
    rOutLow: {
      typ: r3(voL / iolTyp),
      max: r3(voL / iolMin),
      unit: "Ω",
      conditions: { VDD: vdd, VO: voL, ...T25 },
      estimated: true,
      note: `Estimated (not printed). rOutLow = VO/IOL at VO = ${voL} V, VDD = ${vdd} V, 25 °C: typ ${voL} V/${iolTyp * 1e3} mA; max = ${voL} V/${iolMin * 1e3} mA (IOL min, worst-case bound).`,
    },
    rOutHigh: {
      typ: r3(dropH / iohTyp),
      max: r3(dropH / iohMin),
      unit: "Ω",
      conditions: { VDD: vdd, VO: voH, ...T25 },
      estimated: true,
      note: `Estimated (not printed). rOutHigh = (VDD − VO)/|IOH| at VO = ${voH} V, VDD = ${vdd} V, 25 °C: typ ${dropH} V/${iohTyp * 1e3} mA; max = ${dropH} V/${iohMin * 1e3} mA (|IOH| min, worst-case bound).`,
    },
    icc: {
      typ: iddTyp,
      max: iddMax,
      unit: "A",
      conditions: { VDD: vdd, VIN: vin, ...T25 },
    },
  };
}

function cdRatings(): LogicPart["ratings"] {
  return {
    vccMax: { max: 20, unit: "V", conditions: { ref: "VSS" } },
    vccMin: { min: -0.5, unit: "V", conditions: { ref: "VSS" } },
    inputCurrentPerPin: { max: 0.01, unit: "A" }, // magnitude (±10 mA, DC, any one input)
    Pd: {
      max: 0.5,
      unit: "W",
      conditions: {
        TA: "-55 to 100",
        derating: "12 mW/°C to 200 mW for TA = 100 to 125 °C",
      },
    },
  };
}

const CD_DYN_COND = { CL: 50e-12, RL: 200e3, tr: 20e-9, tf: 20e-9 };

// ---------------------------------------------------------------------------

export const LOGIC: LogicPart[] = [
  // -------------------------------------------------------------------------
  {
    id: "74HC00",
    aliases: ["SN74HC00", "SN74HC00N", "74HC00N", "HC00"],
    category: "logic",
    family: "HC",
    function: "quad 2-input NAND",
    manufacturer: "Texas Instruments",
    description: "Quad 2-input positive-NAND gate, 2–6 V high-speed CMOS.",
    package: DIP14,
    pins: [
      { number: 1, name: "1A", function: "Gate 1 input A" },
      { number: 2, name: "1B", function: "Gate 1 input B" },
      { number: 3, name: "1Y", function: "Gate 1 output" },
      { number: 4, name: "2A", function: "Gate 2 input A" },
      { number: 5, name: "2B", function: "Gate 2 input B" },
      { number: 6, name: "2Y", function: "Gate 2 output" },
      { number: 7, name: "GND", function: "Ground" },
      { number: 8, name: "3Y", function: "Gate 3 output" },
      { number: 9, name: "3A", function: "Gate 3 input A" },
      { number: 10, name: "3B", function: "Gate 3 input B" },
      { number: 11, name: "4Y", function: "Gate 4 output" },
      { number: 12, name: "4A", function: "Gate 4 input A" },
      { number: 13, name: "4B", function: "Gate 4 input B" },
      { number: 14, name: "VCC", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "sn74hc00",
        "SCLS181H",
        "Rev. H, December 1982 – revised August 2021",
        "SNx4HC00 Quadruple 2-Input Positive-NAND Gates",
      ),
    ],
    notes: [
      "Pinout: N (PDIP) package, same as D/DB/NS/PW/J/W.",
      'SCLS181H switching table does not state CL numerically (load circuit only says "CL includes probe and test-fixture capacitance"); §9 says all specs are met with ≤ 50 pF.',
      "Cpd = 20 pF typ per gate (no load).",
    ],
    ratings: hcRatings(),
    recommended: hcRecommended(true),
    levels: [
      {
        vcc: 2,
        ...hcInputLevels(2),
        ...hcStdOutputs(2),
        tpd: [tpd(2, 45, 90, "A/B->Y")],
      },
      {
        vcc: 4.5,
        ...hcInputLevels(4.5),
        ...hcStdOutputs(4.5),
        tpd: [tpd(4.5, 9, 18, "A/B->Y")],
      },
      {
        vcc: 6,
        ...hcInputLevels(6),
        ...hcStdOutputs(6),
        tpd: [tpd(6, 8, 15, "A/B->Y")],
        icc: hcIcc(2e-6),
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "74HC04",
    aliases: ["SN74HC04", "SN74HC04N", "74HC04N", "HC04"],
    category: "logic",
    family: "HC",
    function: "hex inverter",
    manufacturer: "Texas Instruments",
    description: "Hex inverter, 2–6 V high-speed CMOS.",
    package: DIP14,
    pins: [
      { number: 1, name: "1A", function: "Inverter 1 input" },
      { number: 2, name: "1Y", function: "Inverter 1 output" },
      { number: 3, name: "2A", function: "Inverter 2 input" },
      { number: 4, name: "2Y", function: "Inverter 2 output" },
      { number: 5, name: "3A", function: "Inverter 3 input" },
      { number: 6, name: "3Y", function: "Inverter 3 output" },
      { number: 7, name: "GND", function: "Ground" },
      { number: 8, name: "4Y", function: "Inverter 4 output" },
      { number: 9, name: "4A", function: "Inverter 4 input" },
      { number: 10, name: "5Y", function: "Inverter 5 output" },
      { number: 11, name: "5A", function: "Inverter 5 input" },
      { number: 12, name: "6Y", function: "Inverter 6 output" },
      { number: 13, name: "6A", function: "Inverter 6 input" },
      { number: 14, name: "VCC", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "sn74hc04",
        "SCLS078H",
        "Rev. H, December 1982 – revised April 2021",
        "SNx4HC04 Hex Inverters",
      ),
    ],
    notes: [
      "Pinout: N (PDIP) package, same as D/DB/NS/PW/J/W.",
      "Switching load: CL = 50 pF (Parameter Measurement Information).",
      "Cpd = 20 pF typ per gate (no load).",
    ],
    ratings: hcRatings(),
    recommended: hcRecommended(true),
    levels: [
      {
        vcc: 2,
        ...hcInputLevels(2),
        ...hcStdOutputs(2),
        tpd: [tpd(2, 45, 95, "A->Y", 50e-12)],
      },
      {
        vcc: 4.5,
        ...hcInputLevels(4.5),
        ...hcStdOutputs(4.5),
        tpd: [tpd(4.5, 9, 19, "A->Y", 50e-12)],
      },
      {
        vcc: 6,
        ...hcInputLevels(6),
        ...hcStdOutputs(6),
        tpd: [tpd(6, 8, 16, "A->Y", 50e-12)],
        icc: hcIcc(2e-6),
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "74HC14",
    aliases: ["SN74HC14", "SN74HC14N", "74HC14N", "HC14"],
    category: "logic",
    family: "HC",
    function: "hex Schmitt inverter",
    manufacturer: "Texas Instruments",
    description: "Hex Schmitt-trigger inverter, 2–6 V high-speed CMOS.",
    package: DIP14,
    pins: [
      { number: 1, name: "1A", function: "Inverter 1 input (Schmitt)" },
      { number: 2, name: "1Y", function: "Inverter 1 output" },
      { number: 3, name: "2A", function: "Inverter 2 input (Schmitt)" },
      { number: 4, name: "2Y", function: "Inverter 2 output" },
      { number: 5, name: "3A", function: "Inverter 3 input (Schmitt)" },
      { number: 6, name: "3Y", function: "Inverter 3 output" },
      { number: 7, name: "GND", function: "Ground" },
      { number: 8, name: "4Y", function: "Inverter 4 output" },
      { number: 9, name: "4A", function: "Inverter 4 input (Schmitt)" },
      { number: 10, name: "5Y", function: "Inverter 5 output" },
      { number: 11, name: "5A", function: "Inverter 5 input (Schmitt)" },
      { number: 12, name: "6Y", function: "Inverter 6 output" },
      { number: 13, name: "6A", function: "Inverter 6 input (Schmitt)" },
      { number: 14, name: "VCC", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "sn74hc14",
        "SCLS085L",
        "Rev. L, December 1982 – revised February 2025",
        "SNx4HC14 Hex Inverters with Schmitt-Trigger Inputs",
      ),
    ],
    notes: [
      "Pinout: N (PDIP) package, same as D/DB/NS/PW/J/W.",
      "Schmitt inputs: no VIH/VIL or input transition-time limit is specified; use VT+/VT−.",
      "Switching load: CL = 50 pF (Parameter Measurement Information).",
      "Cpd = 20 pF typ per gate (no load).",
    ],
    ratings: hcRatings(),
    recommended: hcRecommended(false),
    levels: [
      {
        vcc: 2,
        VTplus: {
          min: 0.7,
          typ: 1.2,
          max: 1.5,
          unit: "V",
          conditions: { VCC: 2, ...T25 },
        },
        VTminus: {
          min: 0.3,
          typ: 0.6,
          max: 1,
          unit: "V",
          conditions: { VCC: 2, ...T25 },
        },
        hysteresis: {
          min: 0.2,
          typ: 0.6,
          max: 1.2,
          unit: "V",
          conditions: { VCC: 2, ...T25 },
        },
        ...hcStdOutputs(2),
        tpd: [tpd(2, 55, 125, "A->Y", 50e-12)],
      },
      {
        vcc: 4.5,
        VTplus: {
          min: 1.55,
          typ: 2.5,
          max: 3.13,
          unit: "V",
          conditions: { VCC: 4.5, ...T25 },
        },
        VTminus: {
          min: 0.9,
          typ: 1.6,
          max: 2.45,
          unit: "V",
          conditions: { VCC: 4.5, ...T25 },
        },
        hysteresis: {
          min: 0.4,
          typ: 0.9,
          max: 2.1,
          unit: "V",
          conditions: { VCC: 4.5, ...T25 },
        },
        ...hcStdOutputs(4.5),
        tpd: [tpd(4.5, 12, 25, "A->Y", 50e-12)],
      },
      {
        vcc: 6,
        VTplus: {
          min: 2.1,
          typ: 3.3,
          max: 4.2,
          unit: "V",
          conditions: { VCC: 6, ...T25 },
        },
        VTminus: {
          min: 1.2,
          typ: 2,
          max: 3.2,
          unit: "V",
          conditions: { VCC: 6, ...T25 },
        },
        hysteresis: {
          min: 0.5,
          typ: 1.3,
          max: 2.5,
          unit: "V",
          conditions: { VCC: 6, ...T25 },
        },
        ...hcStdOutputs(6),
        tpd: [tpd(6, 11, 21, "A->Y", 50e-12)],
        icc: hcIcc(2e-6),
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "74HC74",
    aliases: ["SN74HC74", "SN74HC74N", "74HC74N", "HC74"],
    category: "logic",
    family: "HC",
    function: "dual D-type flip-flop with preset and clear",
    manufacturer: "Texas Instruments",
    description:
      "Dual positive-edge-triggered D flip-flop with active-low preset and clear, 2–6 V CMOS.",
    package: DIP14,
    pins: [
      { number: 1, name: "~1CLR", function: "FF1 clear, active low" },
      { number: 2, name: "1D", function: "FF1 data input" },
      {
        number: 3,
        name: "1CLK",
        function: "FF1 clock, positive-edge triggered",
      },
      { number: 4, name: "~1PRE", function: "FF1 preset, active low" },
      { number: 5, name: "1Q", function: "FF1 output" },
      { number: 6, name: "~1Q", function: "FF1 inverted output" },
      { number: 7, name: "GND", function: "Ground" },
      { number: 8, name: "~2Q", function: "FF2 inverted output" },
      { number: 9, name: "2Q", function: "FF2 output" },
      { number: 10, name: "~2PRE", function: "FF2 preset, active low" },
      {
        number: 11,
        name: "2CLK",
        function: "FF2 clock, positive-edge triggered",
      },
      { number: 12, name: "2D", function: "FF2 data input" },
      { number: 13, name: "~2CLR", function: "FF2 clear, active low" },
      { number: 14, name: "VCC", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "sn74hc74",
        "SCLS094F",
        "Rev. F, December 1982 – revised June 2021",
        "SNx4HC74 Dual D-Type Positive-Edge-Triggered Flip-Flops With Clear and Preset",
      ),
    ],
    notes: [
      "Pinout: N (PDIP) package, same as D/DB/NS/PW/J/W.",
      'Values from the "-74" tables; the "-54" table in SCLS094F prints IOH/IOL as 6/7.8 mA with the same voltages (apparent typo) and ICC 2 µA.',
      "Switching load: CL = 50 pF. Timing at 25 °C, 4.5 V: tsu(D) ≥ 20 ns, th = 0, tw(CLK) ≥ 16 ns, tw(PRE/CLR low) ≥ 20 ns.",
      'Cpd = 35 pF typ (Operating Characteristics table, "per gate").',
    ],
    ratings: hcRatings(),
    recommended: hcRecommended(true),
    levels: [
      {
        vcc: 2,
        ...hcInputLevels(2),
        ...hcStdOutputs(2),
        tpd: [
          tpd(2, 70, 175, "CLK->Q/~Q", 50e-12),
          tpd(2, 70, 230, "~PRE/~CLR->Q/~Q", 50e-12),
        ],
        fmax: {
          min: 6e6,
          typ: 10e6,
          unit: "Hz",
          conditions: { VCC: 2, CL: 50e-12, ...T25 },
        },
      },
      {
        vcc: 4.5,
        ...hcInputLevels(4.5),
        ...hcStdOutputs(4.5),
        tpd: [
          tpd(4.5, 20, 35, "CLK->Q/~Q", 50e-12),
          tpd(4.5, 20, 46, "~PRE/~CLR->Q/~Q", 50e-12),
        ],
        fmax: {
          min: 31e6,
          typ: 50e6,
          unit: "Hz",
          conditions: { VCC: 4.5, CL: 50e-12, ...T25 },
        },
      },
      {
        vcc: 6,
        ...hcInputLevels(6),
        ...hcStdOutputs(6),
        tpd: [
          tpd(6, 15, 30, "CLK->Q/~Q", 50e-12),
          tpd(6, 15, 39, "~PRE/~CLR->Q/~Q", 50e-12),
        ],
        fmax: {
          min: 36e6,
          typ: 60e6,
          unit: "Hz",
          conditions: { VCC: 6, CL: 50e-12, ...T25 },
        },
        icc: hcIcc(4e-6),
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "74HC595",
    aliases: ["SN74HC595", "SN74HC595N", "74HC595N", "HC595"],
    category: "logic",
    family: "HC",
    function: "8-bit shift register with output latch (3-state)",
    manufacturer: "Texas Instruments",
    description:
      "8-bit serial-in shift register feeding an 8-bit storage register with 3-state outputs, 2–6 V CMOS.",
    package: DIP16,
    pins: [
      { number: 1, name: "QB", function: "Parallel output B (3-state)" },
      { number: 2, name: "QC", function: "Parallel output C (3-state)" },
      { number: 3, name: "QD", function: "Parallel output D (3-state)" },
      { number: 4, name: "QE", function: "Parallel output E (3-state)" },
      { number: 5, name: "QF", function: "Parallel output F (3-state)" },
      { number: 6, name: "QG", function: "Parallel output G (3-state)" },
      { number: 7, name: "QH", function: "Parallel output H (3-state)" },
      { number: 8, name: "GND", function: "Ground" },
      {
        number: 9,
        name: "QH'",
        function: "Serial output (cascade), standard output",
      },
      {
        number: 10,
        name: "~SRCLR",
        function: "Shift-register clear, active low",
      },
      {
        number: 11,
        name: "SRCLK",
        function: "Shift-register clock, rising edge",
      },
      {
        number: 12,
        name: "RCLK",
        function: "Storage-register clock, rising edge",
      },
      { number: 13, name: "~OE", function: "Output enable, active low" },
      { number: 14, name: "SER", function: "Serial data input" },
      { number: 15, name: "QA", function: "Parallel output A (3-state)" },
      { number: 16, name: "VCC", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "sn74hc595",
        "SCLS041J",
        "Rev. J, December 1982 – revised October 2021",
        "SNx4HC595 8-Bit Shift Registers With 3-State Output Registers",
      ),
    ],
    notes: [
      "Pinout: N (PDIP) package, same as D/NS/J/DB/PW (pin drawing; the pin table omits the VCC pin number).",
      "QA–QH are bus-driver outputs (IOH/IOL ±6 mA @ 4.5 V, ±7.8 mA @ 6 V); QH' is a standard output (±4 / ±5.2 mA). VOH/VOL voltages are identical; rOut is derived from the QA–QH rows.",
      "tpd entries at CL = 50 pF unless conditions say 150 pF. OE→QA–QH at 4.5 V, 50 pF: ten 15/30 ns, tdis 23/40 ns (typ/max).",
      "IOZ (QA–QH, 6 V) ±0.5 µA max at 25 °C. Cpd = 400 pF typ.",
    ],
    ratings: hcRatings(0.035, 0.07),
    recommended: hcRecommended(true),
    levels: [
      {
        vcc: 2,
        ...hcInputLevels(2),
        VOH: [
          {
            min: 1.9,
            typ: 1.998,
            unit: "V",
            conditions: { VCC: 2, IO: -20e-6, ...T25 },
          },
        ],
        VOL: [
          {
            typ: 0.002,
            max: 0.1,
            unit: "V",
            conditions: { VCC: 2, IO: 20e-6, ...T25 },
          },
        ],
        tpd: [
          tpd(2, 50, 160, "SRCLK->QH'", 50e-12),
          tpd(2, 50, 150, "RCLK->QA..QH", 50e-12),
          tpd(2, 51, 175, "~SRCLR->QH'", 50e-12, { edge: "tPHL" }),
          tpd(2, 60, 200, "RCLK->QA..QH", 150e-12),
        ],
        fmax: {
          min: 6e6,
          typ: 26e6,
          unit: "Hz",
          conditions: { VCC: 2, CL: 50e-12, ...T25 },
        },
      },
      {
        vcc: 4.5,
        ...hcInputLevels(4.5),
        VOH: [
          {
            min: 4.4,
            typ: 4.499,
            unit: "V",
            conditions: { VCC: 4.5, IO: -20e-6, ...T25 },
          },
          {
            min: 3.98,
            typ: 4.3,
            unit: "V",
            conditions: { VCC: 4.5, IO: -0.004, output: "QH'", ...T25 },
          },
          {
            min: 3.98,
            typ: 4.3,
            unit: "V",
            conditions: { VCC: 4.5, IO: -0.006, output: "QA..QH", ...T25 },
          },
        ],
        VOL: [
          {
            typ: 0.001,
            max: 0.1,
            unit: "V",
            conditions: { VCC: 4.5, IO: 20e-6, ...T25 },
          },
          {
            typ: 0.17,
            max: 0.26,
            unit: "V",
            conditions: { VCC: 4.5, IO: 0.004, output: "QH'", ...T25 },
          },
          {
            typ: 0.17,
            max: 0.26,
            unit: "V",
            conditions: { VCC: 4.5, IO: 0.006, output: "QA..QH", ...T25 },
          },
        ],
        rOutHigh: rOut("high", 4.5, 0.006, 4.3, 3.98),
        rOutLow: rOut("low", 4.5, 0.006, 0.17, 0.26),
        tpd: [
          tpd(4.5, 17, 32, "SRCLK->QH'", 50e-12),
          tpd(4.5, 17, 30, "RCLK->QA..QH", 50e-12),
          tpd(4.5, 18, 35, "~SRCLR->QH'", 50e-12, { edge: "tPHL" }),
          tpd(4.5, 22, 40, "RCLK->QA..QH", 150e-12),
        ],
        fmax: {
          min: 31e6,
          typ: 38e6,
          unit: "Hz",
          conditions: { VCC: 4.5, CL: 50e-12, ...T25 },
        },
      },
      {
        vcc: 6,
        ...hcInputLevels(6),
        VOH: [
          {
            min: 5.9,
            typ: 5.999,
            unit: "V",
            conditions: { VCC: 6, IO: -20e-6, ...T25 },
          },
          {
            min: 5.48,
            typ: 5.8,
            unit: "V",
            conditions: { VCC: 6, IO: -0.0052, output: "QH'", ...T25 },
          },
          {
            min: 5.48,
            typ: 5.8,
            unit: "V",
            conditions: { VCC: 6, IO: -0.0078, output: "QA..QH", ...T25 },
          },
        ],
        VOL: [
          {
            typ: 0.001,
            max: 0.1,
            unit: "V",
            conditions: { VCC: 6, IO: 20e-6, ...T25 },
          },
          {
            typ: 0.15,
            max: 0.26,
            unit: "V",
            conditions: { VCC: 6, IO: 0.0052, output: "QH'", ...T25 },
          },
          {
            typ: 0.15,
            max: 0.26,
            unit: "V",
            conditions: { VCC: 6, IO: 0.0078, output: "QA..QH", ...T25 },
          },
        ],
        rOutHigh: rOut("high", 6, 0.0078, 5.8, 5.48),
        rOutLow: rOut("low", 6, 0.0078, 0.15, 0.26),
        tpd: [
          tpd(6, 14, 27, "SRCLK->QH'", 50e-12),
          tpd(6, 14, 26, "RCLK->QA..QH", 50e-12),
          tpd(6, 15, 30, "~SRCLR->QH'", 50e-12, { edge: "tPHL" }),
          tpd(6, 19, 34, "RCLK->QA..QH", 150e-12),
        ],
        fmax: {
          min: 36e6,
          typ: 42e6,
          unit: "Hz",
          conditions: { VCC: 6, CL: 50e-12, ...T25 },
        },
        icc: hcIcc(8e-6),
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "74HCT04",
    aliases: ["SN74HCT04", "SN74HCT04N", "74HCT04N", "HCT04"],
    category: "logic",
    family: "HCT",
    function: "hex inverter (TTL-compatible inputs)",
    manufacturer: "Texas Instruments",
    description: "Hex inverter with TTL-level inputs, 4.5–5.5 V CMOS.",
    package: DIP14,
    pins: [
      { number: 1, name: "1A", function: "Inverter 1 input" },
      { number: 2, name: "1Y", function: "Inverter 1 output" },
      { number: 3, name: "2A", function: "Inverter 2 input" },
      { number: 4, name: "2Y", function: "Inverter 2 output" },
      { number: 5, name: "3A", function: "Inverter 3 input" },
      { number: 6, name: "3Y", function: "Inverter 3 output" },
      { number: 7, name: "GND", function: "Ground" },
      { number: 8, name: "4Y", function: "Inverter 4 output" },
      { number: 9, name: "4A", function: "Inverter 4 input" },
      { number: 10, name: "5Y", function: "Inverter 5 output" },
      { number: 11, name: "5A", function: "Inverter 5 input" },
      { number: 12, name: "6Y", function: "Inverter 6 output" },
      { number: 13, name: "6A", function: "Inverter 6 input" },
      { number: 14, name: "VCC", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "sn74hct04",
        "SCLS042F",
        "Rev. F, July 1986 – revised October 2022",
        "SNx4HCT04 Hex Inverters",
      ),
    ],
    notes: [
      "Primary doc is SCLS042F (the brief's \"SCLS080\" is not this part's literature number).",
      "Pinout: N (PDIP) package, same as J/D/NS/PW.",
      "SCLS042F prints VOH only at VCC = 4.5 V and VOL only at VCC = 5.5 V; each is stored at that supply.",
      "ΔICC (one input at 0.5 V or 2.4 V, others at 0/VCC, 5.5 V): 1.4 mA typ, 2.4 mA max per input. Cpd = 20 pF typ.",
      "Switching load: CL = 50 pF.",
    ],
    ratings: hcRatings(),
    recommended: {
      vcc: { min: 4.5, typ: 5, max: 5.5, unit: "V" },
      inputTransitionTime: [
        { max: 500e-9, unit: "s", conditions: { VCC: "4.5 to 5.5" } },
      ],
    },
    levels: [
      {
        vcc: 4.5,
        VIH: { min: 2, unit: "V", conditions: { VCC: "4.5 to 5.5" } },
        VIL: { max: 0.8, unit: "V", conditions: { VCC: "4.5 to 5.5" } },
        VOH: [
          {
            min: 4.4,
            typ: 4.499,
            unit: "V",
            conditions: { VCC: 4.5, IO: -20e-6, ...T25 },
          },
          {
            min: 3.98,
            typ: 4.3,
            unit: "V",
            conditions: { VCC: 4.5, IO: -0.004, ...T25 },
          },
        ],
        rOutHigh: rOut("high", 4.5, 0.004, 4.3, 3.98),
        tpd: [tpd(4.5, 14, 20, "A->Y", 50e-12)],
      },
      {
        vcc: 5.5,
        VIH: { min: 2, unit: "V", conditions: { VCC: "4.5 to 5.5" } },
        VIL: { max: 0.8, unit: "V", conditions: { VCC: "4.5 to 5.5" } },
        VOL: [
          {
            typ: 0.001,
            max: 0.1,
            unit: "V",
            conditions: { VCC: 5.5, IO: 20e-6, ...T25 },
          },
          {
            typ: 0.17,
            max: 0.26,
            unit: "V",
            conditions: { VCC: 5.5, IO: 0.004, ...T25 },
          },
        ],
        rOutLow: rOut("low", 5.5, 0.004, 0.17, 0.26),
        tpd: [tpd(5.5, 13, 18, "A->Y", 50e-12)],
        icc: {
          max: 2e-6,
          unit: "A",
          conditions: { VCC: 5.5, VI: "VCC or 0", IO: 0, ...T25 },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: "CD4017",
    aliases: ["CD4017B", "CD4017BE", "4017"],
    category: "logic",
    family: "CD4000",
    function: "decade counter / divider with 10 decoded outputs",
    manufacturer: "Texas Instruments",
    description:
      "5-stage Johnson decade counter with 10 decoded outputs, carry out, clock inhibit and reset; 3–18 V CMOS.",
    package: DIP16,
    pins: [
      { number: 1, name: "Q5", function: 'Decoded output "5"' },
      { number: 2, name: "Q1", function: 'Decoded output "1"' },
      { number: 3, name: "Q0", function: 'Decoded output "0"' },
      { number: 4, name: "Q2", function: 'Decoded output "2"' },
      { number: 5, name: "Q6", function: 'Decoded output "6"' },
      { number: 6, name: "Q7", function: 'Decoded output "7"' },
      { number: 7, name: "Q3", function: 'Decoded output "3"' },
      { number: 8, name: "VSS", function: "Ground / negative supply" },
      { number: 9, name: "Q8", function: 'Decoded output "8"' },
      { number: 10, name: "Q4", function: 'Decoded output "4"' },
      { number: 11, name: "Q9", function: 'Decoded output "9"' },
      {
        number: 12,
        name: "CARRY OUT",
        function: "Carry out (high for counts 0–4)",
      },
      {
        number: 13,
        name: "CLOCK INHIBIT",
        function: "Clock inhibit, active high",
      },
      {
        number: 14,
        name: "CLOCK",
        function: "Clock input (Schmitt), advances on rising edge",
      },
      { number: 15, name: "RESET", function: "Reset to count 0, active high" },
      { number: 16, name: "VDD", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "cd4017b",
        "SCHS027C",
        "Rev. C, revised February 2004 (data sheet acquired from Harris Semiconductor)",
        "CD4017B, CD4022B Types — CMOS Counter/Dividers",
      ),
    ],
    notes: [
      "Scanned datasheet; values read visually from the printed tables (not graphs).",
      'Pinout from the CD4017B terminal diagram (E = PDIP). Datasheet labels decoded outputs "0"–"9"; stored as Q0–Q9.',
      "IOH stored as magnitude (source current); datasheet prints negative values.",
      "VOH/VOL rows state no output current (unloaded). Dynamic data: CL = 50 pF, RL = 200 kΩ, input tr = tf = 20 ns.",
      "fmax measured with respect to the carry-out line. IDD at VDD = 20 V: 0.08 µA typ, 100 µA max (25 °C). IIN ±0.1 µA max at 18 V.",
      "Device dissipation per output transistor: 100 mW (full temperature range).",
    ],
    ratings: cdRatings(),
    recommended: {
      vcc: { min: 3, max: 18, unit: "V" },
      inputTransitionTime: [
        {
          max: 15e-6,
          unit: "s",
          conditions: { input: "pin 13 used as clock (pin 14 tied high)" },
          note: "Clock rise/fall time is UNLIMITED when pin 14 is the clock input; ≤ 15 µs applies only when pin 13 is used as the clock.",
        },
      ],
    },
    levels: ([5, 10, 15] as const).map((vdd): LogicLevelPoint => {
      const d = {
        5: {
          idd: 5e-6,
          iddT: 0.04e-6,
          vilVo: "0.5 or 4.5",
          dec: [325, 650],
          co: [300, 600],
          rst: [265, 530],
          f: [2.5e6, 5e6],
        },
        10: {
          idd: 10e-6,
          iddT: 0.04e-6,
          vilVo: "1 or 9",
          dec: [135, 270],
          co: [125, 250],
          rst: [115, 230],
          f: [5e6, 10e6],
        },
        15: {
          idd: 20e-6,
          iddT: 0.04e-6,
          vilVo: "1.5 or 13.5",
          dec: [85, 170],
          co: [80, 160],
          rst: [85, 170],
          f: [5.5e6, 11e6],
        },
      }[vdd];
      return {
        vcc: vdd,
        ...cdStatic(vdd, d.idd, d.iddT, d.vilVo),
        tpd: [
          tpd(vdd, d.dec[0], d.dec[1], "CLOCK->decoded out", 50e-12, {
            VDD: vdd,
            RL: 200e3,
          }),
          tpd(vdd, d.co[0], d.co[1], "CLOCK->CARRY OUT", 50e-12, {
            VDD: vdd,
            RL: 200e3,
          }),
          tpd(vdd, d.rst[0], d.rst[1], "RESET->CARRY OUT/decoded out", 50e-12, {
            VDD: vdd,
            RL: 200e3,
          }),
        ],
        fmax: {
          min: d.f[0],
          typ: d.f[1],
          unit: "Hz",
          conditions: { VDD: vdd, ...CD_DYN_COND, ...T25 },
        },
      };
    }),
  },

  // -------------------------------------------------------------------------
  {
    id: "CD4011",
    aliases: ["CD4011B", "CD4011BE", "4011"],
    category: "logic",
    family: "CD4000",
    function: "quad 2-input NAND",
    manufacturer: "Texas Instruments",
    description: "Quad 2-input NAND gate, buffered B-series CMOS, 3–18 V.",
    package: DIP14,
    pins: [
      { number: 1, name: "A", function: "Gate 1 input" },
      { number: 2, name: "B", function: "Gate 1 input" },
      { number: 3, name: "J", function: "Gate 1 output, J = NOT(A·B)" },
      { number: 4, name: "K", function: "Gate 2 output, K = NOT(C·D)" },
      { number: 5, name: "C", function: "Gate 2 input" },
      { number: 6, name: "D", function: "Gate 2 input" },
      { number: 7, name: "VSS", function: "Ground / negative supply" },
      { number: 8, name: "E", function: "Gate 3 input" },
      { number: 9, name: "F", function: "Gate 3 input" },
      { number: 10, name: "L", function: "Gate 3 output, L = NOT(E·F)" },
      { number: 11, name: "M", function: "Gate 4 output, M = NOT(G·H)" },
      { number: 12, name: "G", function: "Gate 4 input" },
      { number: 13, name: "H", function: "Gate 4 input" },
      { number: 14, name: "VDD", function: "Positive supply" },
    ],
    sources: [
      tiDs(
        "cd4011b",
        "SCHS021D",
        "Rev. D, revised September 2003 (data sheet acquired from Harris Semiconductor)",
        "CD4011B, CD4012B, CD4023B Types — CMOS NAND Gates",
      ),
    ],
    notes: [
      "Scanned datasheet; values read visually from the printed tables (not graphs).",
      "Pinout from the CD4011B terminal assignment (E = PDIP); pin names are the datasheet letters.",
      "IOH stored as magnitude (source current); datasheet prints negative values.",
      "VOH/VOL rows state no output current (unloaded). Dynamic data: CL = 50 pF, RL = 200 kΩ, input tr = tf = 20 ns.",
      "IDD at VDD = 20 V: 0.02 µA typ, 5 µA max (25 °C). IIN ±0.1 µA max at 18 V. CIN 5 pF typ, 7.5 pF max.",
      "Device dissipation per output transistor: 100 mW (full temperature range).",
    ],
    ratings: cdRatings(),
    recommended: { vcc: { min: 3, max: 18, unit: "V" } },
    levels: ([5, 10, 15] as const).map((vdd): LogicLevelPoint => {
      const d = {
        5: { idd: 0.25e-6, iddT: 0.01e-6, vilVo: "4.5", t: [125, 250] },
        10: { idd: 0.5e-6, iddT: 0.01e-6, vilVo: "9", t: [60, 120] },
        15: { idd: 1e-6, iddT: 0.01e-6, vilVo: "13.5", t: [45, 90] },
      }[vdd];
      return {
        vcc: vdd,
        ...cdStatic(vdd, d.idd, d.iddT, d.vilVo),
        tpd: [
          tpd(vdd, d.t[0], d.t[1], "input->output", 50e-12, {
            VDD: vdd,
            RL: 200e3,
          }),
        ],
      };
    }),
  },
];
