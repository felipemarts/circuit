# src/mixed — logic ICs, primitives and analog↔digital co-simulation

Couples the event-driven digital engine (src/digital) to the MNA engine through the
`CoSimHook` of `src/analysis/engine.ts` (`circuit._cosim`). Pure TypeScript, browser-safe,
deterministic.

```
families.ts    logic-family / NE555 electrical models derived from src/parts (per-VCC interpolation)
ics.ts         IC definitions: pin roles + bridge kind per pin, internal behavior as a digital netlist
device.ts      analog-side devices: LogicIC (Part), LogicPrimitive (+ Nand, DFF, Clock, …), output stages
elab.ts        bench elaboration: net classification, bridge plan, lint F135–F138 (+ F130–F134), probes
controller.ts  MixedController (the CoSimHook): DC settle, transient co-simulation, D508–D514
measure.ts     tb.expect.logic evaluation over recorded traces
catalog.ts     `circuitsvibe catalog` entries, generated from the same data
part.ts        icPart(id) — the IC side of Part()
mcu.ts         Mcu / ArduinoUno components: per-pin output stage, pull-ups, clamps (MCU pin model)
mcu-cosim.ts   McuCosim: the McuPinBus over the analog solution, firmware in lockstep, R410–R413, M622/M623
mcu-catalog.ts catalog entries: Mcu, ArduinoUno, the four profiles, VhdlBlock
vhdl-block.ts  VhdlBlock: a VHDL entity as a bench component (per-bit pins, bridged like primitives)
build.ts       rebuild of source-referencing components (firmware / VHDL) from circuit documents
serial-measure.ts  tb.expect.serial evaluation
vcd.ts         RunRecord logic capture → VCD (--vcd)
```

## Nets and bridges

- Every **IC pin is an analog node**. Inputs are threshold detectors referenced to the IC's
  own `V(GND)` and supply `V(VCC) − V(GND)`; outputs are output stages stamped between the
  pin and the IC's VCC/GND pins (so the supply pin carries the load current).
- A net whose pins all belong to **logic primitives** is pure-digital: only the event engine
  sees it (the analog side stamps a decoupled 1 S dummy). A primitive pin on an analog net is
  bridged like an IC pin, with the levels of a family reference part
  (`HC` → 74HC04, `HCT` → 74HCT04, `CD4000` → CD4011) at an ideal `vcc` (default 5 V) vs ground.
- Digital net names: IC pin `U1.<n>` → `_U1_<n>`, IC internal `_U1__<x>`, bridged primitive
  pin `_G1_<pin>`; diagnostics are rewritten back to `U1.1Y`, `U1:clr`, `G1.q`.

| Bridge | Model |
|---|---|
| `logic` input | level 1 when V ≥ VIH(vs), 0 when V ≤ VIL(vs), previous value held in between (guaranteed levels); D508 on a long dwell |
| `schmitt` input | VT+ / VT− typ (74HC14); CD4017 CLOCK uses VIH/VIL as its hysteresis |
| clamp diodes | Shockley Is = 1e-14 A to VCC and GND on logic inputs (`clamp: false` removes them); D513 |
| `pushpull` / `tristate` output | pull-up `s·e/Rhigh` to VCC, pull-down `(1−s)·e/Rlow` to GND; s = high fraction (X → 0.5), e = enable (Z → 0); s and e ramp linearly over `ramp` (0.2 × tpd typ; NE555: 100 ns rise time) |
| Rout | from the datasheet VOH/VOL rows (catalog `rOutHigh/rOutLow`), interpolated in conductance over VCC, updated from the accepted supply each step |
| NE555 | THRES > CONT, TRIG < CONT/2, RESET < GND + 0.7 V comparators; CONT = internal 5k–(5k+5k) divider; latch (RESET > TRIG > THRES priority) as a DFF with async set/reset, 100 ns (model) delay; discharge = Ron from the saturation rows; output high = VCC − 0.9 V − 8 Ω·I (VOH rows), low = VOL rows |
| delays | catalog tpd (typ, or max with `corner: 'worst'`) at the IC's supply at t = 0, minus ln2·Rout·50 pF and ramp/2 (the datasheet's 50 pF test load is re-created by the analog side) |
| unpowered | supply < ½ min recommended → outputs high-Z (D510); a transient brown-out latches the IC off |

## Algorithm

**DC points** (op, DC-sweep points, the transient t = 0 point): after each converged solve the
controller classifies every input (with the previous level as hysteresis; a first
classification uses the VIL/VIH midpoint), powers the digital netlist on with those levels
(the engine's zero-delay settle of level-sensitive behavior; flip-flops at their init state)
and sets the output stages. The point is re-solved while outputs or power states change,
up to 24 passes (then D514).

**Transient** (adaptive stepper only):
1. `beginTransient` builds one `DigitalSim` with delays at the t = 0 supplies, inputs at the
   settled levels; its power-on state equals the DC settle.
2. `nextBreakpoint(t)` = min(next digital event, next output-ramp end): the stepper lands on
   every digital output change and ramp corner (BE restart there).
3. `locate(t0, x0, t1, x1)`: for every input, the signed distance to its switching threshold
   (threshold re-evaluated from the supply at each end) is linearly interpolated; if a
   crossing lies more than `crossTol` (1 ps … 1 ns, 1e-7·tstop) before t1 the step is rejected
   and retried to the crossing + crossTol/2.
4. `accepted(t1, x1)`: crossings in (t0, t1] are driven into their digital nets at the
   interpolated times, the digital side advances to t1 (never beyond), output changes start
   ramps at their exact event times; supplies, output currents (D511), clamp currents (D513),
   forbidden-zone dwell (D508) and supply range (D509/D510) are checked.
5. After the run: digital diagnostics (D501–D507) are renamed and merged; the recording feeds
   `tb.expect.logic` and `stages.tran.logic`.

Accuracy (tests): RC → 74HC04 switches within 0.5 ns of the analytic VIH crossing at 220 ns;
74HC04 tpd into 50 pF within 20 % of the datasheet value (measured −0.5 % / +3 %); 74HC14 RC
oscillator within 3 % of T = RC·[ln((VCC−VT−)/(VCC−VT+)) + ln(VT+/VT−)]; NE555 astable and
monostable within 2 % of 1.44/((R1+2R2)C) and 1.1·RC.

## Microcontrollers and VHDL blocks

- **MCU** pins are analog nodes like IC pins, but their role changes at run time (the firmware's
  `pinMode`): OUTPUT = an `OutputStage` between the MCU's VCC/GND pins (Rout from
  src/mcu/electrical.ts), INPUT_PULLUP = the internal resistor, every pin keeps ESD clamps and
  1 GΩ leakage. The controller forwards `beginTransient`, `nextBreakpoint` (firmware wake
  times + ramp corners), `locate` (interrupt pins), `accepted` and the asynchronous
  `work(t)` (the engine awaits `runUntil(t)`) to one `McuCosim` per MCU. In reset (op,
  unpowered, brown-out) every pin is high-Z.
- **VHDL blocks** are classified like logic primitives (pure-digital nets when every pin on
  the net is a primitive or a VHDL block); their elaborated processes join the bench's
  digital netlist, bridged pins get `logic` inputs and `tristate` outputs at the ideal `vcc`.
  VHDL diagnostics keep their `.vhd` `at`.

## Part() seam (merging with other part families)

`src/elab/part.ts` exports `Part(id, opts)`, which calls `icPart(id, opts)` (this module) and
throws if it returns `undefined`. Another family adds its own `xxxPart(id, opts)` returning
`undefined` for ids it does not simulate, and `Part()` becomes
`icPart(id, opts) ?? xxxPart(id, opts) ?? throw`. Netlist `type` of an IC is its catalog id
(`'74HC00'`), params `{ corner, clamp }`; `buildComponent` rebuilds it through
`buildMixedComponent` (checked after a custom definition of the same name).

## Known gaps

- Supply-dependent tpd is fixed at the t = 0 supply (Rout and thresholds track the supply).
- After a brown-out the IC stays off (no re-power); unpowered inputs keep their last level.
- DC sweeps re-settle the logic at every point (with hysteresis), AC linearizes the output
  stages at the op; logic levels never change inside the AC analysis.
- 74HC74 with ~PRE and ~CLR both low gives X (datasheet: both outputs high).
- No ground bounce / supply current of the core (Icc), no output slew vs load beyond Rout·C,
  no input capacitance; NE555 trigger/threshold input currents are not modeled.
- `runFixed` (the UI's fixed-step path) refuses co-simulated circuits.
