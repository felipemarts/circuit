/**
 * Electrical model of MCU pins for the analog bridge (src/mixed/mcu.ts) —
 * plain data derived from the datasheet rows cited in each entry. Kept apart
 * from the runtime profiles (src/mcu/profiles.ts: what the firmware sees) so
 * the profile numbers stay the single source of pin capabilities, logic
 * thresholds and current limits; this file adds what the analog side needs.
 *
 * Output drive: a push-pull Thevenin stage from the MCU's own VCC/GND pins.
 *   Rout = ΔV / I at the datasheet's guaranteed output-level row
 *   (VOH(min) at IOH, VOL(max) at IOL), at two supply voltages; in between the
 *   conductance is interpolated linearly over VCC (clamped outside). These are
 *   the GUARANTEED (worst-case) levels: a typical part at 25 °C drives harder
 *   (roughly half the resistance on the ATmega328P characterization curves).
 */
import type { McuProfile } from './types';

export interface DrivePoint {
  /** Supply voltage of the datasheet row (V). */
  vcc: number;
  /** Pull-up (output high) resistance: (VCC − VOH) / |IOH| (Ω). */
  rHigh: number;
  /** Pull-down (output low) resistance: VOL / IOL (Ω). */
  rLow: number;
  /** The datasheet row, in words. */
  row: string;
}

export interface McuElectrical {
  /** Output resistance at one or two supply voltages (ascending vcc). */
  drive: DrivePoint[];
  /** The drive numbers are an estimate (not a guaranteed datasheet row). */
  driveEstimated?: boolean;
  /** Nominal internal pull-up (Ω) — the profile's range midpoint. */
  pullup: number;
  /** Nominal internal pull-down (Ω), where the part has one. */
  pulldown?: number;
  /** Below this VCC−GND the MCU is held in reset: pins high-Z, firmware stopped (V). */
  resetBelow: number;
  /** What sets resetBelow (BOD fuse, POR, minimum supply). */
  resetSource: string;
  /** Recommended supply for the modelled clock (V). */
  vccRecommended: [number, number];
  /** Absolute maximum supply (V). */
  vccAbsMax: number;
  /** Output edge ramp of the model (s) — a numerical model choice, not a datasheet value. */
  ramp: number;
  /** Datasheet sections the numbers come from. */
  sources: string[];
}

const ATMEGA_DS = 'Microchip DS40002061B (ATmega48A/PA/88A/PA/168A/PA/328/P)';

/** Per-profile electrical data (keys = profile ids). */
export const MCU_ELECTRICAL: Record<string, McuElectrical> = {
  atmega328p: {
    drive: [
      { vcc: 3, rHigh: (3 - 2.3) / 10e-3, rLow: 0.6 / 10e-3, row: 'VOH ≥ 2.3 V at IOH = −10 mA, VOL ≤ 0.6 V at IOL = 10 mA (VCC = 3 V)' },
      { vcc: 5, rHigh: (5 - 4.2) / 20e-3, rLow: 0.9 / 20e-3, row: 'VOH ≥ 4.2 V at IOH = −20 mA, VOL ≤ 0.9 V at IOL = 20 mA (VCC = 5 V)' },
    ],
    pullup: 35e3,
    resetBelow: 2.7,
    resetSource: 'brown-out detector at VBOT = 2.7 V typ (Arduino Uno fuses: extended 0xFD, BODLEVEL = 101; datasheet BODLEVEL fuse coding: 2.5–2.9 V)',
    vccRecommended: [4.5, 5.5],
    vccAbsMax: 6.0,
    ramp: 10e-9,
    sources: [
      `${ATMEGA_DS} Table 30-1 Common DC characteristics (VOH/VOL rows, RPU 20–50 kΩ, VIL 0.3·VCC, VIH 0.6·VCC)`,
      `${ATMEGA_DS} §30.3 Speed grades (16 MHz needs VCC 4.5–5.5 V), §29.1 Absolute maximum ratings (VCC 6.0 V)`,
      `${ATMEGA_DS} BODLEVEL fuse coding (VBOT 2.7 V); ArduinoCore-avr boards.txt uno.bootloader.extended_fuses=0xFD`,
    ],
  },
  attiny85: {
    drive: [
      { vcc: 3, rHigh: (3 - 2.5) / 5e-3, rLow: 0.5 / 5e-3, row: 'VOH ≥ 2.5 V at IOH = −5 mA, VOL ≤ 0.5 V at IOL = 5 mA (VCC = 3 V)' },
      { vcc: 5, rHigh: (5 - 4.3) / 10e-3, rLow: 0.6 / 10e-3, row: 'VOH ≥ 4.3 V at IOH = −10 mA, VOL ≤ 0.6 V at IOL = 10 mA (VCC = 5 V)' },
    ],
    pullup: 35e3,
    resetBelow: 1.8,
    resetSource: 'ATTinyCore default fuses leave the brown-out detector off; the model holds the part in reset below 1.8 V (the V-grade minimum supply) — a model choice',
    vccRecommended: [2.7, 5.5],
    vccAbsMax: 6.0,
    ramp: 10e-9,
    sources: [
      'Atmel-2586 ATtiny25/45/85 Table 21-1 DC characteristics (VOH/VOL rows, RPU 20–50 kΩ)',
      'Atmel-2586 §21.3 Speed (0–10 MHz at 2.7–5.5 V), §21.1 Absolute maximum ratings (VCC 6.0 V)',
    ],
  },
  esp32: {
    drive: [{ vcc: 3.3, rHigh: (3.3 - 2.64) / 20e-3, rLow: 0.495 / 14e-3, row: 'VOH ≥ 0.8·VDD at IOH ≈ 40 mA and VOL ≤ 0.495 V at IOL ≈ 28 mA at the maximum drive strength, halved for the default drive (GPIO_DRIVE_CAP_2)' }],
    driveEstimated: true,
    pullup: 45e3,
    pulldown: 45e3,
    resetBelow: 2.43,
    resetSource: 'ESP-IDF brown-out detector default level 0 (≈ 2.43 V)',
    vccRecommended: [3.0, 3.6],
    vccAbsMax: 3.6,
    ramp: 10e-9,
    sources: [
      'Espressif ESP32 Series datasheet v5.3, Table 5-3 DC characteristics (VOH 0.8·VDD, VOL 0.1·VDD, IOH 40 mA / IOL 28 mA typ at max drive, RPU/RPD 45 kΩ)',
      'Espressif ESP32 Series datasheet v5.3, Table 5-1 absolute maximum (VDD 3.6 V) and §5.2 recommended operating conditions (3.0–3.6 V)',
    ],
  },
  rp2040: {
    drive: [{ vcc: 3.3, rHigh: (3.3 - 2.62) / 4e-3, rLow: 0.5 / 4e-3, row: 'VOH ≥ 2.62 V at IOH = 4 mA, VOL ≤ 0.5 V at IOL = 4 mA (IOVDD 3.3 V, default 4 mA drive)' }],
    pullup: 65e3,
    pulldown: 65e3,
    resetBelow: 1.62,
    resetSource: 'minimum IOVDD (1.62 V); the RP2040 has no configurable brown-out — a model choice',
    vccRecommended: [1.62, 3.63],
    vccAbsMax: 3.63,
    ramp: 10e-9,
    sources: [
      'Raspberry Pi RP2040 datasheet §5.5.3 IO electrical characteristics (VOH/VOL at the 4 mA drive setting, RPU/RPD 50–80 kΩ)',
      'Raspberry Pi RP2040 datasheet §5.5.1 absolute maximum ratings (IOVDD 3.63 V)',
    ],
  },
};

export function mcuElectrical(profile: McuProfile): McuElectrical {
  const e = MCU_ELECTRICAL[profile.id];
  if (!e) throw new Error(`no electrical model for MCU profile '${profile.id}'`);
  return e;
}

/** Output resistances at a supply voltage (conductance interpolated over VCC, clamped). */
export function driveAt(e: McuElectrical, vcc: number): { rHigh: number; rLow: number } {
  const d = e.drive;
  if (d.length === 1 || vcc <= d[0].vcc) return { rHigh: d[0].rHigh, rLow: d[0].rLow };
  const last = d[d.length - 1];
  if (vcc >= last.vcc) return { rHigh: last.rHigh, rLow: last.rLow };
  for (let i = 1; i < d.length; i++) {
    if (vcc <= d[i].vcc) {
      const a = d[i - 1];
      const b = d[i];
      const f = (vcc - a.vcc) / (b.vcc - a.vcc);
      const g = (x: number, y: number) => 1 / (1 / x + f * (1 / y - 1 / x));
      return { rHigh: g(a.rHigh, b.rHigh), rLow: g(a.rLow, b.rLow) };
    }
  }
  return { rHigh: last.rHigh, rLow: last.rLow };
}

/** Input thresholds at a supply (rise = VIH, fall = VIL, relative to GND). */
export function thresholdsAt(profile: McuProfile, vs: number): { vil: number; vih: number } {
  const l = profile.logic;
  return l.absolute ? { vil: l.vilMax, vih: l.vihMin } : { vil: l.vilMax * vs, vih: l.vihMin * vs };
}
