/**
 * Real-parts catalog — type definitions.
 *
 * Pure data, browser-safe. Conventions:
 *  - Every number is in SI base units: A, V, W, F, s, Ω, Hz, V/s, C (charge),
 *    temperatures in °C. Gains in dB are stored as dB (unit 'dB'); plain ratios use unit '1'.
 *  - A `Spec` carries min/typ/max as published, the unit, and the test conditions
 *    (also SI) it was specified at.
 *  - Anything not printed in the cited document but derived/estimated carries
 *    `estimated: true` and a `note` explaining how it was obtained.
 *  - `source` on a value/model is a `Citation.id` of the same part; when omitted the
 *    value comes from the part's first citation (its primary datasheet).
 */

export type PartCategory =
  | 'diode'
  | 'bjt'
  | 'mosfet'
  | 'opamp'
  | 'comparator'
  | 'logic'
  | 'timer'
  | 'mcu';

/**
 * Units used across the catalog. 'xVCC' = fraction of the supply voltage; 'm' is used for
 * optical wavelengths and 'cd' for luminous intensity (LEDs).
 */
export type Unit =
  | 'A'
  | 'V'
  | 'W'
  | 'F'
  | 's'
  | 'Ω'
  | '°C'
  | '°C/W'
  | 'Hz'
  | 'V/s'
  | 'dB'
  | 'deg'
  | 'C'
  | 'S'
  | 'A/V²'
  | 'V/√Hz'
  | 'A/√Hz'
  | '1'
  | 'xVCC'
  | 'bit'
  | 'm'
  | 'cd';

export type CitationKind =
  | 'datasheet'
  | 'spice-model'
  | 'reference-manual'
  | 'application-note'
  | 'library'
  | 'other';

export interface Citation {
  /** Local key referenced by `Spec.source` / `SpiceModel.source` (e.g. 'ds', 'model'). */
  id: string;
  kind: CitationKind;
  /** Manufacturer or publishing organisation. */
  publisher: string;
  title: string;
  /** Document / literature number, e.g. 'SLOS068AB', '2N3903/D'. */
  document?: string;
  /** Revision and/or date as printed, e.g. 'Rev. 9, August 2021'. */
  revision?: string;
  url: string;
  /** ISO date the URL was checked. */
  accessed?: string;
  note?: string;
}

/** Test conditions, SI units. Keys are conventional symbols: VCE, IC, VGS, ID, VCC, CL, RL, TA, TJ, f, ... */
export type Conditions = Readonly<Record<string, number | string>>;

/** A datasheet quantity. At least one of min/typ/max is present. */
export interface Spec {
  min?: number;
  typ?: number;
  max?: number;
  unit: Unit;
  conditions?: Conditions;
  /**
   * When set, min/typ/max are signed offsets from that rail: V = V(rail) + value.
   * Physical ordering is kept (min ≤ typ ≤ max), so a high-side limit has its guaranteed
   * worst case in `min` and a low-side limit in `max`. e.g. "VOH ≥ V+ − 1.5 V, typ V+ − 1 V"
   * → { min: -1.5, typ: -1, relativeTo: 'V+' }; "VOL ≤ V− + 20 mV" → { max: 0.02, relativeTo: 'V-' }.
   */
  relativeTo?: 'V+' | 'V-';
  /** True when the value is derived/estimated rather than printed in the source. */
  estimated?: boolean;
  /** Required when `estimated` is true: how the value was obtained. */
  note?: string;
  /** Citation id; defaults to the part's first citation. */
  source?: string;
}

export interface PinDef {
  /** Physical pin number (or module pad label). */
  number: number;
  name: string;
  /** Short functional description. */
  function?: string;
}

export interface PackageInfo {
  /** e.g. 'DO-35', 'TO-92', 'SOT-23', 'DIP-8', 'DIP-14', 'TO-220AB'. */
  name: string;
  pinCount: number;
}

// ---------------------------------------------------------------------------
// SPICE-style model cards

export interface DiodeModelParams {
  Is?: number; // A
  N?: number; // 1
  Rs?: number; // Ω
  Cjo?: number; // F
  Vj?: number; // V
  M?: number; // 1
  Tt?: number; // s
  BV?: number; // V
  IBV?: number; // A
  Fc?: number; // 1
  Eg?: number; // eV
  Xti?: number; // 1
  /** Extra published params (e.g. Isr, Nr, Ikf, Nbv) kept verbatim, SI. */
  [extra: string]: number | undefined;
}

export interface BjtModelParams {
  Is?: number;
  Bf?: number;
  Br?: number;
  Nf?: number;
  Nr?: number;
  Vaf?: number;
  Var?: number;
  Ikf?: number;
  Ikr?: number;
  Ise?: number;
  Ne?: number;
  Isc?: number;
  Nc?: number;
  Rb?: number;
  Re?: number;
  Rc?: number;
  Cje?: number;
  Vje?: number;
  Mje?: number;
  Cjc?: number;
  Vjc?: number;
  Mjc?: number;
  Tf?: number;
  Tr?: number;
  Xtb?: number;
  Eg?: number;
  Xti?: number;
  Fc?: number;
  Itf?: number;
  Vtf?: number;
  Xtf?: number;
  [extra: string]: number | undefined;
}

/**
 * Level-1 (Shichman–Hodges) parameters, lumped convention: W = L = 1, so
 * Id(sat) = (Kp/2)·(Vgs − Vto)²·(1 + Lambda·Vds) and Cgso/Cgdo/Cbd are total capacitances in F.
 * For P-channel devices Vto is negative.
 */
export interface MosfetModelParams {
  Vto?: number;
  Kp?: number; // A/V²
  Lambda?: number; // 1/V
  Gamma?: number; // √V
  Phi?: number; // V
  Rd?: number;
  Rs?: number;
  Rg?: number;
  Cgso?: number;
  Cgdo?: number;
  Cbd?: number;
  [extra: string]: number | undefined;
}

export type SpiceDeviceType = 'D' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS';

export interface SpiceModel<P> {
  type: SpiceDeviceType;
  /** SPICE level when relevant (MOSFET: 1). */
  level?: number;
  params: P;
  /** The `.model` line as published by `source`, verbatim (when one exists). */
  modelLine?: string;
  /** Citation id where the model card comes from. */
  source: string;
  /** True when the whole card is a fit/estimate rather than a published model. */
  estimated?: boolean;
  /** Required when `estimated`: derivation. */
  note?: string;
  /** Per-parameter estimation notes: a key here means that param is estimated. */
  estimatedParams?: Partial<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Common part fields

export interface PartBase {
  /** Canonical id, e.g. '1N4148', '2N3904', '74HC00'. Unique across the catalog. */
  id: string;
  aliases?: string[];
  category: PartCategory;
  /** Manufacturer of the primary (first-cited) datasheet. */
  manufacturer: string;
  description: string;
  package: PackageInfo;
  pins: PinDef[];
  sources: Citation[];
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Diodes

export interface DiodeRatings {
  VRRM?: Spec;
  VR?: Spec;
  IFAV?: Spec;
  /** Continuous forward current (LEDs / small-signal). */
  IF?: Spec;
  IFSM?: Spec;
  /** Peak pulsed forward current (LEDs). */
  IFP?: Spec;
  Pd?: Spec;
  TjMax?: Spec;
}

export interface DiodeCharacteristics {
  VF?: Spec[];
  IR?: Spec[];
  /** Junction / total capacitance. */
  Cj?: Spec[];
  trr?: Spec[];
  /** Zener voltage at Izt. */
  Vz?: Spec;
  Izt?: Spec;
  Zzt?: Spec;
  Zzk?: Spec;
  Izk?: Spec;
  /** LEDs: peak / dominant wavelength, unit 'm'. */
  wavelengthPeak?: Spec;
  wavelengthDominant?: Spec;
  /** LEDs: luminous intensity, unit 'cd'. */
  luminousIntensity?: Spec;
}

export interface DiodePart extends PartBase {
  category: 'diode';
  kind: 'signal' | 'rectifier' | 'schottky' | 'zener' | 'led';
  model?: SpiceModel<DiodeModelParams>;
  ratings: DiodeRatings;
  characteristics?: DiodeCharacteristics;
}

// ---------------------------------------------------------------------------
// BJTs

export interface BjtRatings {
  Vceo: Spec;
  Vcbo?: Spec;
  Vebo?: Spec;
  IcMax: Spec;
  IcPeak?: Spec;
  IbMax?: Spec;
  /** Total dissipation at TA = 25 °C. */
  Pd: Spec;
  /** Total dissipation at TC = 25 °C (power packages). */
  PdCase?: Spec;
  TjMax: Spec;
}

export interface BjtCharacteristics {
  hFE?: Spec[];
  VCEsat?: Spec[];
  VBEsat?: Spec[];
  VBEon?: Spec[];
  fT?: Spec[];
  Cob?: Spec[];
  Cib?: Spec[];
  ICBO?: Spec[];
}

export interface BjtPart extends PartBase {
  category: 'bjt';
  polarity: 'NPN' | 'PNP';
  darlington?: boolean;
  model?: SpiceModel<BjtModelParams>;
  ratings: BjtRatings;
  characteristics?: BjtCharacteristics;
}

// ---------------------------------------------------------------------------
// MOSFETs

export interface MosfetRatings {
  Vds: Spec;
  /** Symmetric gate–source limit: stored as max = |VGS|max (±). */
  Vgs: Spec;
  /** Continuous drain current at TC (or TA for small-signal) = 25 °C. */
  Id25: Spec;
  Id100?: Spec;
  IdPulsed?: Spec;
  Pd: Spec;
  TjMax: Spec;
}

export interface MosfetCharacteristics {
  RdsOn?: Spec[];
  VgsTh?: Spec;
  gfs?: Spec[];
  Ciss?: Spec;
  Coss?: Spec;
  Crss?: Spec;
  Qg?: Spec;
  Qgs?: Spec;
  Qgd?: Spec;
  /** Body-diode forward voltage. */
  Vsd?: Spec;
  trr?: Spec;
  /** Transfer-curve points read off the datasheet figure (estimated reads). */
  transferPoints?: Spec[];
}

export interface MosfetPart extends PartBase {
  category: 'mosfet';
  channel: 'N' | 'P';
  model?: SpiceModel<MosfetModelParams>;
  bodyDiode?: SpiceModel<DiodeModelParams>;
  ratings: MosfetRatings;
  characteristics?: MosfetCharacteristics;
}

// ---------------------------------------------------------------------------
// Op-amps and comparators

export interface SupplyRange {
  /** Single-supply total voltage range. */
  single?: Spec;
  /** Dual supply, per rail (±). */
  dual?: Spec;
}

export interface AmplifierRatings {
  /** Absolute max total supply (V+ − V−). */
  supplyMax: Spec;
  differentialInputMax?: Spec;
  inputVoltageMin?: Spec;
  inputVoltageMax?: Spec;
  Pd?: Spec;
  TjMax?: Spec;
}

export interface OpAmpCharacteristics {
  supply: SupplyRange;
  /** Large-signal open-loop voltage gain, in dB. */
  openLoopGain?: Spec;
  gbw?: Spec;
  slewRate?: Spec;
  inputOffsetVoltage?: Spec;
  inputBiasCurrent?: Spec;
  inputOffsetCurrent?: Spec;
  /** Input common-mode range, both ends expressed relative to the rails. */
  inputCommonModeLow?: Spec;
  inputCommonModeHigh?: Spec;
  /** Output swing ends relative to the rails, with load in conditions. */
  outputSwingLow?: Spec[];
  outputSwingHigh?: Spec[];
  outputShortCircuitCurrent?: Spec[];
  /** Quiescent supply current (whole package unless conditions say per channel). */
  supplyCurrent?: Spec[];
  phaseMargin?: Spec;
  cmrr?: Spec;
  psrr?: Spec;
  inputNoiseVoltage?: Spec;
}

export interface OpAmpPart extends PartBase {
  category: 'opamp';
  channels: number;
  railToRailInput?: boolean;
  railToRailOutput?: boolean;
  ratings: AmplifierRatings;
  characteristics: OpAmpCharacteristics;
}

export interface ComparatorCharacteristics {
  supply: SupplyRange;
  inputOffsetVoltage?: Spec;
  inputBiasCurrent?: Spec;
  inputOffsetCurrent?: Spec;
  inputCommonModeLow?: Spec;
  inputCommonModeHigh?: Spec;
  voltageGain?: Spec;
  responseTime?: Spec[];
  outputSinkCurrent?: Spec[];
  saturationVoltage?: Spec[];
  outputLeakageCurrent?: Spec[];
  supplyCurrent?: Spec[];
}

export interface ComparatorPart extends PartBase {
  category: 'comparator';
  channels: number;
  output: 'open-collector' | 'push-pull';
  ratings: AmplifierRatings;
  characteristics: ComparatorCharacteristics;
}

// ---------------------------------------------------------------------------
// Logic

export type LogicFamily = 'HC' | 'HCT' | 'CD4000';

export interface LogicRatings {
  vccMax: Spec;
  vccMin?: Spec;
  /** Input clamp (diode) current, |IIK| max. */
  inputClampCurrent?: Spec;
  outputClampCurrent?: Spec;
  /** Continuous output current per pin, |IO| max. */
  outputCurrentPerPin?: Spec;
  /** Continuous current through VCC or GND, |ICC|/|IGND| max. */
  supplyPinCurrent?: Spec;
  inputCurrentPerPin?: Spec;
  Pd?: Spec;
  TjMax?: Spec;
}

/** Recommended operating supply range. */
export interface LogicRecommended {
  vcc: Spec;
  /** Max input rise/fall time (non-Schmitt inputs), when stated. */
  inputTransitionTime?: Spec[];
}

/** DC/AC data at one supply voltage. */
export interface LogicLevelPoint {
  vcc: number;
  VIH?: Spec;
  VIL?: Spec;
  /** Schmitt-trigger thresholds. */
  VTplus?: Spec;
  VTminus?: Spec;
  hysteresis?: Spec;
  VOH?: Spec[];
  VOL?: Spec[];
  /** Output resistance derived from VOH/VOL vs load current (estimated). */
  rOutHigh?: Spec;
  rOutLow?: Spec;
  tpd?: Spec[];
  /** Max clock frequency for sequential parts. */
  fmax?: Spec;
  /** Quiescent supply current (static). */
  icc?: Spec;
  /** Output drive current (CD4000 IOL/IOH). */
  IOL?: Spec[];
  IOH?: Spec[];
}

export interface LogicPart extends PartBase {
  category: 'logic';
  family: LogicFamily;
  /** e.g. 'quad 2-input NAND', 'hex Schmitt inverter', '8-bit shift register with latch'. */
  function: string;
  ratings: LogicRatings;
  recommended: LogicRecommended;
  levels: LogicLevelPoint[];
}

// ---------------------------------------------------------------------------
// 555 timer

export interface TimerCharacteristics {
  supply: Spec;
  /** Threshold level (pin 6), as fraction of VCC. */
  thresholdLevel: Spec;
  /** Trigger level (pin 2), as fraction of VCC. */
  triggerLevel: Spec;
  thresholdVoltage?: Spec[];
  triggerVoltage?: Spec[];
  thresholdCurrent?: Spec;
  triggerCurrent?: Spec;
  resetVoltage?: Spec;
  resetCurrent?: Spec[];
  controlVoltage?: Spec[];
  dischargeSaturation?: Spec[];
  dischargeLeakage?: Spec;
  VOL?: Spec[];
  VOH?: Spec[];
  outputCurrentMax?: Spec;
  supplyCurrent?: Spec[];
  riseTime?: Spec;
  fallTime?: Spec;
  timingError?: Spec[];
  maxFrequency?: Spec;
}

export interface TimerPart extends PartBase {
  category: 'timer';
  ratings: AmplifierRatings;
  characteristics: TimerCharacteristics;
}

// ---------------------------------------------------------------------------
// Microcontroller profiles

export interface McuPinMapping {
  /** Board / core name, e.g. 'D5', 'A0', 'GPIO2'. */
  name: string;
  /** Port pin, e.g. 'PD5'. */
  port: string;
  /** Physical package pin number (or module pad). */
  physicalPin?: number;
  /** PWM capability (Arduino-core / SDK default). */
  pwm?: { timer?: string; channel?: string; frequency?: Spec };
  adcChannel?: number;
  notes?: string;
}

export interface McuProfile extends PartBase {
  category: 'mcu';
  core: string;
  supply: Spec;
  /** Supply voltage the profile's derived numbers assume. */
  nominalVcc: number;
  clock: { max: Spec; default?: Spec; internalOscillator?: Spec };
  logic: {
    VIL: Spec;
    VIH: Spec;
    VOL?: Spec[];
    VOH?: Spec[];
    /** True if I/O tolerates > VCC (generally false here). */
    fiveVoltTolerant?: boolean;
  };
  currents: {
    perPinAbsMax?: Spec;
    perPinRecommended?: Spec;
    /** Total package / VCC / GND pin limits. */
    totalAbsMax?: Spec[];
    groupLimits?: Spec[];
  };
  pullUp: Spec;
  pullDown?: Spec;
  adc: {
    resolution: Spec;
    channels?: number;
    references: { name: string; voltage?: Spec; note?: string }[];
    inputRange?: Spec;
    sampleRate?: Spec;
  };
  pwm?: {
    resolution?: Spec;
    defaultFrequency?: Spec;
    note?: string;
  };
  ratings: {
    vccMax: Spec;
    pinVoltageMax?: Spec;
    TjMax?: Spec;
  };
  /** Board-level mapping (e.g. Arduino Uno D0–D13/A0–A5). */
  boardMapping?: { board: string; pins: McuPinMapping[] };
}

export type PartEntry =
  | DiodePart
  | BjtPart
  | MosfetPart
  | OpAmpPart
  | ComparatorPart
  | LogicPart
  | TimerPart
  | McuProfile;
