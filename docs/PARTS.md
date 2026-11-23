# Parts catalog

`src/parts/` is a pure-data catalog of real components: datasheet absolute maximum
ratings, key electrical characteristics, pinouts and, for discrete semiconductors,
SPICE-style model cards. It contains no simulation code; later phases wire it into device
models. It has no Node dependencies, so it is safe to use in the browser.

```ts
import { PARTS, findPart, partsByCategory } from './src/parts';

const q = findPart('2n3904');                  // case-insensitive; aliases work too ('LM555' → NE555)
if (q?.category === 'bjt') q.model?.params.Bf; // 206.302
partsByCategory('logic').map((p) => p.id);
```

## Data conventions

- **SI base units everywhere**: A, V, W, F, s, Ω, Hz, V/s; temperatures in °C. 4 pF is
  `4e-12`, 625 mW is `0.625`. Open-loop gain, CMRR and PSRR are stored in dB (unit `'dB'`);
  datasheet values in V/mV are converted with 20·log10, which is a unit conversion, not an
  estimate. `'xVCC'` means a fraction of the supply (for example the 555 thresholds or AVR
  VIH). LED wavelengths use `'m'` and luminous intensity `'cd'`.
- **`Spec`** = `{ min?, typ?, max?, unit, conditions?, relativeTo?, estimated?, note?, source? }`.
  `min`/`typ`/`max` are the datasheet columns. `conditions` holds the test conditions in SI
  (`{ IC: 0.01, VCE: 1, TA: 25 }`). Absolute maximum ratings go in `max`.
- **Polarity**: ratings and characteristics of PNP and P-channel parts are stored as
  magnitudes (commented `// magnitude` in the source); the part's `polarity`/`channel`
  gives the sign. SPICE model parameters keep their true signs (PMOS `Vto < 0`).
- **Rail-relative specs** (`relativeTo: 'V+' | 'V-'`): V = V(rail) + value, with the
  physical ordering kept, so a high-side limit has its guaranteed worst case in `min`
  ("VOH ≥ V+ − 1.5 V" → `{ min: -1.5, relativeTo: 'V+' }`) and a low-side limit in `max`.
- **Sources**: every part has `sources: Citation[]` (publisher, title, document number,
  revision, URL, access date). The first citation is the primary datasheet and the default
  source of every value; a value from another document names it with `source: '<id>'`.
  Model cards cite where their `.model` line comes from; `params` holds its numeric
  values in SI. The library text itself is not copied (see the licensing note below).
- **Omitted, not guessed**: when a datasheet does not print a value it is left out. There
  are no SPICE defaults filled in.
- **Estimated values**: anything derived, fitted or read off a figure has
  `estimated: true` and a `note` with the formula and inputs. A fitted model card has
  `estimated: true` and a `note` on the card; single fitted parameters on an otherwise
  published card are listed in `estimatedParams` (param name → note). The tests enforce
  that every estimated value has a note.
- **Pins**: every part lists every pin (pin number → name), and `package.pinCount` equals
  the number of pins. Discrete pin numbers follow the cited datasheet's drawing (TO-92 pin
  orders differ between manufacturers). Diodes and LEDs, whose leads are not numbered,
  use 1 = anode, 2 = cathode. Active-low IC pins start with `~` (`~OE`, `~MR`).

## Schema

Types live in `src/parts/types.ts`; `PartEntry` is a union discriminated by `category`:

| Category | Type | Main fields |
|---|---|---|
| `diode` | `DiodePart` | `kind` (signal, rectifier, schottky, zener, led), `model` (Is, N, Rs, Cjo, Vj, M, Tt, BV, IBV, Fc…), `ratings` (VRRM, VR, IFAV, IF, IFSM, IFP, Pd, TjMax), `characteristics` (VF, IR, Cj, trr, Vz, Izt, Zzt, Zzk, wavelength, intensity) |
| `bjt` | `BjtPart` | `polarity`, `darlington`, `model` (Gummel-Poon), `ratings` (Vceo, Vcbo, Vebo, IcMax, IcPeak, Pd at TA = 25 °C, PdCase, TjMax), `characteristics` (hFE, VCEsat, VBEsat, VBEon, fT, Cob, Cib) |
| `mosfet` | `MosfetPart` | `channel`, `model` (Level-1, lumped W = L = 1), `bodyDiode`, `ratings` (Vds, ±Vgs, Id25, Id100, IdPulsed, Pd, TjMax), `characteristics` (RdsOn, VgsTh, gfs, Ciss/Coss/Crss, Qg/Qgs/Qgd, Vsd, trr, transferPoints) |
| `opamp` | `OpAmpPart` | `channels`, rail-to-rail flags, `ratings` (supplyMax, differential input, input range, Pd, TjMax), `characteristics` (supply single/dual, open-loop gain, GBW, slew rate, VOS, IB, IOS, input common-mode range, output swing, short-circuit current, supply current, phase margin, CMRR, PSRR, noise) |
| `comparator` | `ComparatorPart` | `output` (open-collector), response time, output sink current, saturation voltage, leakage, gain |
| `timer` | `TimerPart` | threshold/trigger levels (xVCC and volts), pin currents, reset, discharge saturation and leakage, VOL/VOH, output current, supply current, timing error, max frequency |
| `logic` | `LogicPart` | `family` (HC, HCT, CD4000), `ratings` (VCC max, clamp currents, output current per pin, VCC/GND current, Pd), `recommended` (VCC range, input transition time), `levels[]` per supply voltage (VIH, VIL, VT+, VT−, hysteresis, VOH/VOL at stated currents, derived output resistance, tpd, fmax, ICC, IOL/IOH) |
| `mcu` | `McuProfile` | supply, clock, VIL/VIH, VOL/VOH, per-pin and total current limits, pull-ups, ADC (resolution, channels, references), PWM, `boardMapping` (Arduino Uno D0–D13/A0–A5 → port pins, PWM timers and default frequencies) |

The registry (`src/parts/index.ts`) exports `PARTS`, the per-category arrays (`DIODES`,
`BJTS`, `MOSFETS`, `AMPLIFIERS`, `TIMERS`, `LOGIC`, `MCUS`), `findPart(id)` and
`partsByCategory(category)`.

## Parts and sources

All URLs were checked on 2026-11-23.

### Diodes

| Part | Description | Primary datasheet | Model card | Other sources |
|---|---|---|---|---|
| 1N4148 | Small-signal fast switching diode, 100 V, 150 mA average, trr 4 ns (DO-35) | [Vishay Semiconductors 81857](https://www.vishay.com/docs/81857/1n4148.pdf), Rev. 1.6, 07-Nov-2024 | published: 1N4148 SPICE model (High-speed diodes), PSpice .prm | [Nexperia](https://assets.nexperia.com/documents/spice-model/1N4148.prm) |
| 1N4007 | General-purpose plastic rectifier, 1000 V, 1 A (1N4001–1N4007 family, DO-41) | [Vishay General Semiconductor 88503](https://www.vishay.com/docs/88503/1n4001.pdf), Revision: 29-Apr-2020 | published: 1N4007G SPICE model (DI_1N4007G, Glass Passivated Rectifier) | [Diodes Incorporated](https://www.diodes.com/spice/download/344/1N4007G.spice.txt) |
| 1N5819 | Schottky barrier rectifier, 40 V, 1 A (1N5817–1N5819 family, DO-41) | [Diodes Incorporated DS23001](https://www.diodes.com/assets/Datasheets/ds23001.pdf), Rev. 10 - 2, April 2023 | published: Schottky (.5A and Above) SPICE model collection — entry DI_1N5819 | [Diodes Incorporated](https://www.diodes.com/productcollection/spicemodels/8309/Schottky-%28.5A-and-Above%29.spice.txt?eid=94) |
| 1N4733A | Zener diode 5.1 V ±5 %, 1 W (1N4728A–1N4758A family, DO-41 axial) | [onsemi 1N4736AT/D](https://www.onsemi.com/download/data-sheet/pdf/1n4736at-d.pdf), Rev. 10, August 2021 | fit from datasheet (estimated) | [Vishay Semiconductors 85816](https://www.vishay.com/docs/85816/1n4728a.pdf), Rev. 2.7, 07-Nov-2024 |
| BZX79-C3V3 | Voltage regulator (Zener) diode 3.3 V ±5 % (C tolerance), 500 mW (BZX79 series, SOD27/DO-35) | [Nexperia (formerly NXP Semiconductors)](https://assets.nexperia.com/documents/data-sheet/BZX79.pdf), 2002 Feb 27 (supersedes 1999 May 25) | fit from datasheet (estimated) | — |
| LED-RED-5MM | Generic 5 mm (T-1 3/4) red LED; data from Kingbright WP7113SRD/D (Super Bright Red GaAlAs, red diffused, 30°) | [Kingbright DSAF2433 / 1101005271-02](https://www.kingbrightusa.com/images/catalog/SPEC/WP7113SRD-D.pdf), Rev. V.9A, 08/05/2020 | fit from datasheet (estimated) | — |
| LED-GREEN-5MM | Generic 5 mm (T-1 3/4) green LED; data from Kingbright WP7113GD (Green GaP, green diffused, 30°) | [Kingbright DSAE9335 / 1101005001](https://www.kingbrightusa.com/images/catalog/SPEC/WP7113GD.pdf), Rev. V.12B, 04/02/2019 | fit from datasheet (estimated) | — |

### BJTs

| Part | Description | Primary datasheet | Model card | Other sources |
|---|---|---|---|---|
| 2N3904 | General-purpose NPN small-signal transistor, 40 V / 200 mA | [onsemi 2N3903/D](https://www.onsemi.com/pdf/datasheet/2n3903-d.pdf), Rev. 9, August 2021 | published: 2N3904 PSpice model (MODPEX, Symmetry Design Systems) | [onsemi 2N3904.LIB](https://www.onsemi.com/pub/Collateral/2N3904.LIB), Model generated on Aug 7, 01 |
| 2N3906 | General-purpose PNP small-signal transistor, 40 V / 200 mA | [onsemi 2N3906/D](https://www.onsemi.com/pdf/datasheet/2n3906-d.pdf), Rev. 4, February 2010 | published: 2N3906 PSpice model (MODPEX, Symmetry Design Systems) | [onsemi 2N3906.LIB](https://www.onsemi.com/pub/Collateral/2N3906.LIB), Model generated on Aug 7, 01 |
| BC547B | NPN amplifier transistor, 45 V / 100 mA, hFE group B (200–450 at 2 mA) | [onsemi BC546/D](https://www.onsemi.com/pdf/datasheet/bc546-d.pdf), Rev. 8, August 2021 | published: BC547B PSpice model (MODPEX, Symmetry Design Systems) | [onsemi BC547B.LIB](https://www.onsemi.com/pub/Collateral/BC547B.LIB), Model generated on May 12, 05 |
| BC557B | PNP amplifier transistor, 45 V / 100 mA, hFE group B (180–460 at 2 mA) | [onsemi BC556B/D](https://www.onsemi.com/pdf/datasheet/bc556b-d.pdf), Rev. 3, March 2007 | published: LTspice IV standard.bjt (stock library, mirrored on GitHub) | [Linear Technology / Analog Devices (LTspice) lib/cmp/standard.bjt](https://raw.githubusercontent.com/mpkopec/ltspice-lib/2df358aae06c33c6974a687f12b13dc333de7a8c/cmp/standard.bjt), LTspice IV library update 2016-04-02 (Copyright 2000-2016 Linear Technology Corporation) |
| 2N2222A | NPN general-purpose amplifier/switch, 40 V / 600 mA (onsemi P2N2222A, TO-92) | [onsemi P2N2222A/D](https://www.onsemi.com/pdf/datasheet/p2n2222a-d.pdf), Rev. 7, January 2013 | — | — |
| TIP120 | NPN Darlington power transistor, 60 V / 5 A, 65 W, built-in base-emitter shunt resistors | [onsemi TIP120/D](https://www.onsemi.com/pdf/datasheet/tip120-d.pdf), Rev. 10, June 2024 | published: TIP120 PSpice Darlington macro model (MODPEX, Symmetry Design Systems) | [onsemi TIP120.LIB](https://www.onsemi.com/pub/Collateral/TIP120.LIB), Model generated on Dec 26, 2003 |
| BD139 | NPN medium-power transistor, 80 V / 1.5 A, 12.5 W (complement BD140) | [onsemi BD135/D](https://www.onsemi.com/pdf/datasheet/bd135-d.pdf), Rev. 18, June 2024 | published: BD139 PSpice model (MODPEX, Symmetry Design Systems) | [onsemi BD139.LIB](https://www.onsemi.com/pub/Collateral/BD139.LIB), Model generated on Feb 14, 2004 |

### MOSFETs

| Part | Description | Primary datasheet | Model card | Other sources |
|---|---|---|---|---|
| 2N7000 | N-channel enhancement small-signal MOSFET, 60 V / 200 mA, TO-92 | [onsemi NDS7002A/D](https://www.onsemi.com/download/data-sheet/pdf/nds7002a-d.pdf), Rev. 11, March 2025 | Level-1 fit from datasheet curves (estimated) | [onsemi 2N7000/D](https://www.onsemi.com/download/data-sheet/pdf/2n7000-d.pdf), Rev. 8, April 2011 |
| BS170 | N-channel small-signal MOSFET, 60 V / 500 mA, TO-92 | [onsemi BS170/D](https://www.onsemi.com/download/data-sheet/pdf/bs170-d.pdf), Rev. 7, November 2017 | Level-1 fit from datasheet curves (estimated) | [onsemi MMBF170/D](https://www.onsemi.com/download/data-sheet/pdf/mmbf170-d.pdf), Rev. 9, February 2026 |
| IRLZ44N | N-channel logic-level HEXFET power MOSFET, 55 V / 47 A, 22 mΩ, TO-220AB | [Infineon Technologies (International Rectifier) PD-94831](https://www.infineon.com/dgdl/irlz44npbf.pdf?fileId=5546d462533600a40153567217c32725), 11/11/03 | Level-1 fit from datasheet curves (estimated) | — |
| IRF540N | N-channel HEXFET power MOSFET, 100 V / 33 A, 44 mΩ, TO-220 | [Infineon Technologies](https://www.infineon.com/dgdl/irf540npbf.pdf?fileId=5546d462533600a4015355e39f0d19a1), Rev. 2.1, 2026-07-24 | Level-1 fit from datasheet curves (estimated) | — |
| IRF9540N | P-channel HEXFET power MOSFET, −100 V / −23 A, 117 mΩ, TO-220AB | [Infineon Technologies (International Rectifier) PD-94790A](https://www.infineon.com/dgdl/irf9540npbf.pdf?fileId=5546d462533600a4015355e3be0c19a7), 01/23/04 | Level-1 fit from datasheet curves (estimated) | — |
| AO3400A | N-channel trench MOSFET, 30 V / 5.7 A, 26.5 mΩ @10 V (logic level to 2.5 V), SOT-23 | [Alpha & Omega Semiconductor](https://www.aosmd.com/res/datasheets/AO3400A.pdf), Rev 3.1, July 2023 | Level-1 fit from datasheet curves (estimated) | — |
| BSS84 | P-channel enhancement small-signal MOSFET, −50 V / −130 mA, SOT-23 | [onsemi BSS84/D](https://www.onsemi.com/download/data-sheet/pdf/bss84-d.pdf), Rev. 5, October 2021 | Level-1 fit from datasheet curves (estimated) | — |

### Op-amps

| Part | Description | Primary datasheet | Other sources |
|---|---|---|---|
| LM358 | Dual low-power bipolar op-amp, input common-mode range includes ground (LM358, non-A/non-B grade) | [Texas Instruments SLOS068AB](https://www.ti.com/lit/ds/symlink/lm358.pdf), June 1976 – revised October 2024 | — |
| LM741 | General-purpose single bipolar op-amp with offset null (LM741C commercial grade, PDIP-8) | [Texas Instruments SNOSC25D](https://www.ti.com/lit/ds/symlink/lm741.pdf), May 1998 – revised October 2015 | — |
| TL072 | Dual low-noise JFET-input op-amp (TL072C grade) | [Texas Instruments SLOS080W](https://www.ti.com/lit/ds/symlink/tl072.pdf), September 1978 – revised July 2025 | — |
| MCP6002 | Dual 1 MHz low-power CMOS op-amp, rail-to-rail input and output, 1.8 V to 6.0 V | [Microchip Technology DS20001733L](https://ww1.microchip.com/downloads/en/DeviceDoc/MCP6001-1R-1U-2-4-1-MHz-Low-Power-Op-Amp-DS20001733L.pdf), Revision L (March 2020) | — |
| NE5532 | Dual low-noise high-drive bipolar audio op-amp | [Texas Instruments SLOS075K](https://www.ti.com/lit/ds/symlink/ne5532.pdf), November 1979 – revised December 2025 | — |

### Comparators

| Part | Description | Primary datasheet | Other sources |
|---|---|---|---|
| LM393 | Dual differential comparator, open-collector outputs (LM393, non-A/non-B grade) | [Texas Instruments SLCS005AH](https://www.ti.com/lit/ds/symlink/lm393.pdf), October 1979 – revised April 2025 | — |
| LM311 | Single differential comparator with strobe, open-collector output with separate emitter pin | [Texas Instruments SLCS007K](https://www.ti.com/lit/ds/symlink/lm311.pdf), September 1973 – revised March 2017 | — |

### Timer

| Part | Description | Primary datasheet | Other sources |
|---|---|---|---|
| NE555 | Bipolar precision timer, monostable/astable, 200 mA totem-pole output | [Texas Instruments SLFS022K](https://www.ti.com/lit/ds/symlink/ne555.pdf), September 1973 – revised March 2026 | [Texas Instruments SNAS548D](https://www.ti.com/lit/ds/symlink/lm555.pdf), February 2000 – revised January 2015 |

### Logic

| Part | Description | Primary datasheet | Other sources |
|---|---|---|---|
| 74HC00 | Quad 2-input positive-NAND gate, 2–6 V high-speed CMOS. | [Texas Instruments SCLS181H](https://www.ti.com/lit/ds/symlink/sn74hc00.pdf), Rev. H, December 1982 – revised August 2021 | — |
| 74HC04 | Hex inverter, 2–6 V high-speed CMOS. | [Texas Instruments SCLS078H](https://www.ti.com/lit/ds/symlink/sn74hc04.pdf), Rev. H, December 1982 – revised April 2021 | — |
| 74HC14 | Hex Schmitt-trigger inverter, 2–6 V high-speed CMOS. | [Texas Instruments SCLS085L](https://www.ti.com/lit/ds/symlink/sn74hc14.pdf), Rev. L, December 1982 – revised February 2025 | — |
| 74HC74 | Dual positive-edge-triggered D flip-flop with active-low preset and clear, 2–6 V CMOS. | [Texas Instruments SCLS094F](https://www.ti.com/lit/ds/symlink/sn74hc74.pdf), Rev. F, December 1982 – revised June 2021 | — |
| 74HC595 | 8-bit serial-in shift register feeding an 8-bit storage register with 3-state outputs, 2–6 V CMOS. | [Texas Instruments SCLS041J](https://www.ti.com/lit/ds/symlink/sn74hc595.pdf), Rev. J, December 1982 – revised October 2021 | — |
| 74HCT04 | Hex inverter with TTL-level inputs, 4.5–5.5 V CMOS. | [Texas Instruments SCLS042F](https://www.ti.com/lit/ds/symlink/sn74hct04.pdf), Rev. F, July 1986 – revised October 2022 | — |
| CD4017 | 5-stage Johnson decade counter with 10 decoded outputs, carry out, clock inhibit and reset; 3–18 V CMOS. | [Texas Instruments SCHS027C](https://www.ti.com/lit/ds/symlink/cd4017b.pdf), Rev. C, revised February 2004 (data sheet acquired from Harris Semiconductor) | — |
| CD4011 | Quad 2-input NAND gate, buffered B-series CMOS, 3–18 V. | [Texas Instruments SCHS021D](https://www.ti.com/lit/ds/symlink/cd4011b.pdf), Rev. D, revised September 2003 (data sheet acquired from Harris Semiconductor) | — |

### Microcontroller profiles

| Part | Description | Primary datasheet | Other sources |
|---|---|---|---|
| ATmega328P | 8-bit AVR microcontroller, 32 KB flash, 2 KB SRAM, 1 KB EEPROM, 10-bit ADC (Arduino Uno R3 MCU) | [Microchip Technology DS40002061B](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf), Rev. B, 09/2020 | [Arduino](https://docs.arduino.cc/language-reference/en/functions/analog-io/analogWrite/)<br>[Arduino](https://github.com/arduino/ArduinoCore-avr/blob/master/cores/arduino/wiring.c)<br>[Arduino](https://github.com/arduino/ArduinoCore-avr/blob/master/variants/standard/pins_arduino.h)<br>[Arduino SKU A000066](https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf), Revision 5, 12/11/2026 (Modified 19/11/2026) |
| ATtiny85 | 8-bit AVR microcontroller, 8 KB flash, 512 B SRAM/EEPROM, 6 I/O, 10-bit ADC | [Microchip Technology (Atmel) 2586Q–AVR–08/2013](https://ww1.microchip.com/downloads/en/devicedoc/atmel-2586-avr-8-bit-microcontroller-attiny25-attiny45-attiny85_datasheet.pdf), Rev. 2586Q, 08/2013 | [Spence Konde (ATTinyCore)](https://github.com/SpenceKonde/ATTinyCore/blob/v2.0.0-devThis-is-the-head-submit-PRs-against-this/avr/extras/ATtiny_x5.md) |
| ESP32-WROOM-32 | Wi-Fi + Bluetooth module with ESP32-D0WDQ6 dual-core Xtensa LX6, 4 MB flash, 40 MHz crystal (NRND) | [Espressif Systems](https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32_datasheet_en.pdf), v3.8, 2026-09-16 | [Espressif Systems](https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf), v5.3, 2026.07<br>[Espressif Systems](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html)<br>[Espressif Systems](https://github.com/espressif/arduino-esp32/blob/master/cores/esp32/esp32-hal-ledc.c) |
| RP2040 | Dual Cortex-M0+ microcontroller, 264 kB SRAM, external QSPI flash, 30 GPIO, 4-channel 12-bit ADC | [Raspberry Pi Ltd](https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf), Release 13, build date 19/11/2026 (build version 4c5ccacb2c2f) | [Raspberry Pi Ltd](https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf), Release 22, build date 19/11/2026 (build version d9d02bdfeecd) |

## Estimated values

Values not printed in the cited document are marked `estimated: true`, and each one's
`note` gives the formula and inputs. Where they occur:

### MOSFET Level-1 model cards (all estimated)

Vendors publish subcircuits, Level-3, BSIM or VDMOS models, not Level-1 cards, so each
MOSFET has a fitted Level-1 card (`level: 1`, lumped convention W = L = 1, so
Id(sat) = (Kp/2)·(Vgs − Vto)²·(1 + Lambda·Vds)):

1. Two (Vgs, Id) points are read off the datasheet transfer-characteristic figure at
   25 °C, in saturation. They are stored as `characteristics.transferPoints` (estimated).
   Vector figures were read from the PDF drawing coordinates, raster figures from pixels.
2. √Id is linear in Vgs: Vto = (Vg1·√I2 − Vg2·√I1)/(√I2 − √I1) and
   Kp = 2·((√I2 − √I1)/(Vg2 − Vg1))². Every fitted Vto lies within the datasheet VGS(th)
   window, so no fallback was needed.
3. Rd = RDS(on) − 1/(Kp·(Vgs − Vto)) at the RDS(on) test condition (typical RDS(on) when
   printed, otherwise max), and Rs = 0. The transfer curve is measured at the pins, so it
   already includes source resistance; putting part of the remainder into Rs would lower
   the saturation current the fit was built to match.
4. Lambda comes from the output-characteristic slope where it is readable, otherwise it
   is omitted.
5. Cgdo ≈ Crss, Cgso ≈ Ciss − Crss and Cbd ≈ Coss − Crss, from the typical values at the
   datasheet VDS. The real capacitances are strongly voltage dependent.
6. The body diode (`bodyDiode`) has Is/N/Rs fitted from the source–drain diode
   forward-voltage figure.

| Part | Transfer points (Vgs V, Id A) | Vto (V) | Kp (A/V²) | Rd (Ω) | Lambda (1/V) | Body diode Is / N / Rs |
|---|---|---|---|---|---|---|
| 2N7000 | Fig. 5: (2.966, 0.10), (4.428, 0.50) | 1.78 | 0.143 | 0.349 | 0.012 | 4.4e-13 / 1.14 / 0.125 |
| BS170 | output curves, VDS = 20 V: (4, 0.122), (6, 0.58) | 2.31 | 0.085 | 0.271 | — | 5.3e-13 / 1.13 / 0.126 |
| IRLZ44N | Fig. 3: (3.108, 22.2), (3.663, 42.95) | 1.69 | 22.0 | 0.0165 | 0.0023 | 3.86e-13 / 1 (assumed) / 0.0071 |
| IRF540N | Fig. 3: (4.669, 16.07), (5.155, 33.7) | 3.58 | 27.3 | 0.0383 | — | 1.26e-10 / 1.25 / 0.0064 |
| IRF9540N | Fig. 3: (5.898, 10.2), (7.336, 24.8) | −3.33 | 3.09 | 0.0684 | — | 1.4e-9 / 1.42 / 0.0077 |
| AO3400A | Fig. 2: (1.620, 2.007), (1.759, 5.998) | 1.43 | 110 | 0.0169 | 0.0054 | 3.7e-12 / 1.0 / 0.018 |
| BSS84 | Fig. 5: (2.091, 0.0328), (2.357, 0.1304) | −1.82 | 0.921 | 0.858 | — | 2.06e-12 / 1.17 / 0.194 |

Known limits, which each card's note repeats:

- **2N7000**: the model's RDS(on) at 4.5 V is 2.9 Ω, against 1.8 Ω typical.
- **IRLZ44N**: the model gives 30.3 mΩ at 5 V (datasheet max 25 mΩ) and 36.2 mΩ at 4 V
  (max 35 mΩ).
- **IRF540N** overestimates current above about 60 A, and **BSS84** above about 0.5 A.
- **IRLZ44N body diode**: N = 1 is assumed, because the figure starts at 10 A where Rs
  dominates.
- **Infineon parts** (IRLZ44N, IRF540N, IRF9540N) print no typical RDS(on), so Rd is
  based on the max value and these models lean toward higher on-resistance.
- **AO3400A and BSS84**: `Rg` is the printed typical gate resistance, listed in
  `estimatedParams` because it is a lumped stand-in for the real gate network.
- **BS170**: BS170/D has no transfer figure, so the points come from the
  output-characteristic curves. Its Coss and Crss are read from Fig. 6. The body-diode
  data and IdPulsed come from onsemi's MMBF170/D sheet, which is cited separately.

### Diode model cards

- **1N4733A and BZX79-C3V3**: no manufacturer model was found, so each card holds only
  BV = nominal Vz and IBV = Izt (both in `estimatedParams`). Forward parameters are
  omitted.
- **LED-RED-5MM**: Is = 1.41e-21 A, N = 1.575, Rs = 2.75 Ω, least-squares fitted to 23
  points (1–30 mA) extracted from the Kingbright forward-current-vs-voltage curve. The
  fit error is 1.9 mV rms, and the model gives 1.85 V at 20 mA, which matches the
  datasheet's typical value.
- **LED-GREEN-5MM**: Is = 5.73e-19 A, N = 2.0 (fixed; a free fit gave an unphysical
  0.58), Rs = 10.89 Ω, fitted to 12 points (1–20 mA). The error is 12 mV rms, and the
  model gives 2.04 V at 10 mA against 2.0 V typical.
- **LED capacitance**: no Cjo is set on either LED card. The datasheets' typical
  capacitance is stored as a characteristic instead.

### Logic output resistance

`rOutLow`/`rOutHigh` on every logic part are derived, not printed:

- **HC/HCT**: rOutLow = VOL/IOL and rOutHigh = (VCC − VOH)/|IOH| at the high-current row
  (4 mA at 4.5 V and 5.2 mA at 6 V; 6 mA and 7.8 mA for the 74HC595 Q outputs) at
  TA = 25 °C. `typ` uses the typical column; `max` uses the guaranteed VOL max / VOH min
  as a worst-case bound. At 2 V there is no high-current row, so there is no estimate.
- **CD4000**: R = VO/IOL (sink) and (VDD − VO)/|IOH| (source), from the output-drive
  specs at the stated VO.

### Other single values

- **TIP120 fT** ≥ 4 MHz: computed as |hfe| ≥ 4.0 at the 1 MHz test frequency. The
  datasheet does not print fT.
- **LM741 GBW**, 1.17 MHz: from the datasheet's own formula BW = 0.35/rise time, using
  the LM741C rise time of 0.3 µs.
- **MCP6002 differential input max**: printed as |VDD − VSS|, so it is bounded by the
  7.0 V absolute-max supply.
- **ATmega328P (Arduino Uno PWM)**: the Arduino reference prints rounded values (490 Hz,
  980 Hz on pins 5/6). The exact frequencies are computed with the datasheet formulas at
  16 MHz and prescaler 64 (from ArduinoCore-avr `wiring.c`): fast PWM on Timer0 (pins
  5/6) gives 16 MHz/(64·256) = 976.5625 Hz, and phase-correct PWM (pins 3, 9, 10, 11)
  gives 16 MHz/(64·510) = 490.196 Hz. The 8-bit resolution is inferred from the 0..255
  `analogWrite` range.
- **MCU pin voltage max and ADC input range**: printed as VCC + 0.5 V and GND..VREF, and
  evaluated at the profile's nominal supply (5 V for the AVRs, 3.3 V for the RP2040).
- **ATtiny85 default clock**, 1 MHz: the 8 MHz internal RC divided by 8, because parts
  ship with the CKDIV8 fuse set.

## Caveats

- **onsemi BJT model files** (2N3904, 2N3906, BC547B, BD139, TIP120 `.LIB`): these are
  automated MODPEX fits and some parameters look unusual (2N3904 NF = 1.5 and VAF = 1000;
  BC547B BF = 1343.6 with a large ISE/NE that pulls the effective gain down). They are
  copied as published. Their library files carry a Symmetry Design Systems "commercial use
  or resale restricted" notice, and the LTspice `standard.bjt` line used for BC557B is
  Analog Devices library content, so only the numeric parameter values are kept (with
  the citation), never the library text.
- **TIP120**: onsemi's model is a `.SUBCKT`. The `model` field holds its driver-transistor
  `.model`. A single transistor with these params is not a Darlington; the notes describe
  the subcircuit (output transistor area 2.80758, R1 = 10 kΩ, R2 = 1 kΩ, a C–E diode) and
  the datasheet equivalent circuit (about 8 kΩ and 120 Ω).
- **Model cards not directly from the part's datasheet maker**:
  - **1N4007**: Diodes Inc publishes a model only for its glass-passivated 1N4007G (same
    1 kV/1 A rating).
  - **1N4148**: the card is Nexperia's (`.SUBCKT`; the 5.8 GΩ parallel leakage resistor
    is not in `params`), while the datasheet is Vishay's.
- **No model card**: 2N2222A (onsemi publishes none, and stock LTspice has only 2N2222).
  Every op-amp, comparator, logic part and timer is behavioural data only.
- **Scanned datasheets**: IRF9540N (PD-94790A), CD4017B and CD4011B have no text layer.
  Their table values were read from rendered pages. Figure reads from them are marked
  estimated; table values are not.
- **Datasheet choices that matter**:
  - **LM741**: LM741C grade (PDIP part LM741CN): ±18 V, TjMax 100 °C.
  - **TL072**: TL07xC rows that apply to the PDIP package.
  - **NE555**: TI's current revision (SLFS022K) dropped the initial timing-error spec, so the
    initial timing accuracy, the 15 mA and 4.5 mA discharge saturation and Pd come from the LM555 (SNAS548D)
    citation. The 100 kHz maximum-frequency figure is TI application guidance, not a
    tested limit.
  - **ATmega328P**: DC levels come from DS40002061B Table 30-1 (−40 to 105 °C), because
    the 85 °C chapter has no common DC table.
  - **ESP32-WROOM-32**: the module is marked NRND by Espressif.
