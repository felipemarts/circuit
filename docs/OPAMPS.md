# Op-amps and comparators

Three component types and seven real parts (`src/opamps/`). Everything here works in the
op, dc, ac and tran stages, serializes to plain JSON (circuit documents and share links),
and is pure TypeScript.

| Type | Pins | What it is |
|------|------|------------|
| `IdealOpAmp` | `inp`, `inn`, `out`, optional `v+`, `v-` | VCVS `V(out) = gain·(V(inp) − V(inn))`; with both supply pins wired the output is clamped to the rails |
| `OpAmp` | `inp`, `inn`, `out`, `v+`, `v-` (required) | macro model: Aol, GBW, optional 2nd pole, slew rate, output swing, rout, short-circuit current, Vos, Ib, Ios, quiescent current |
| `Comparator` | `inp`, `inn`, `out`, `v+`, `v-` (+ `emit`) | open-collector output, response time that depends on the overdrive, VOL/IOL saturation, leakage |
| `Part('LM358')` … | as `OpAmp` / `Comparator` | the model with parameters derived from the datasheet data in `src/parts` |

The input pins are `inp` (non-inverting) and `inn` (inverting) — not `+`/`-`, which are the
two-terminal source pins. Probes: `U1.v` = V(out) to ground, `U1.i` = current OUT of the
output pin (positive when sourcing, negative while a comparator sinks).

```ts
import { bench, VoltageSource, Resistor, OpAmp, IdealOpAmp, Comparator, Part } from 'circuitsvibe';

const u1 = tb.add('U1', Part('TL072'));                     // one channel of the dual
const u2 = tb.add('U2', new OpAmp({ aol: 1e5, gbw: '1M', sr: '1M' }));
const u3 = tb.add('U3', new IdealOpAmp());                   // no rails: unclamped VCVS
const c1 = tb.add('C1', Part('LM393'));                      // needs a pull-up on 'out'
u1.pin('v+').connect(vcc.pin('+'));
u1.pin('v-').connect(vee.pin('+'));                          // or tb.gnd for a single supply
```

## Models

### IdealOpAmp

`V(out) = A·vd`, `vd = V(inp) − V(inn)`, A = `gain` (default 1e6), zero output resistance,
no input current, infinite bandwidth (frequency-independent in AC). With both supply pins
connected: `V(out) = Vmid + Vh·tanh(A·vd/Vh)`, Vmid = (V+ + V−)/2, Vh = (V+ − V−)/2. The
supply pins draw no current. Leave both supply pins open, or wire both (one of two = F120).
The output is an ideal source to ground: on gnd or across another ideal source it is F123.

### OpAmp (macro model)

Internal gain node `y` (an extra MNA unknown), τ1 = aol/(2π·gbw), ωp = 1/τ1:

```
τ1·dy/dt = (1/ωp)·P(vd)·G(y) − (y − ymid) − aol·[ramp(y − yhi − 3δ) − ramp(ylo − 3δ − y)]
P(vd)    = sr·tanh(2π·gbw·vd/sr),     vd = V(inp) − V(inn) + vos
[ylo, yhi] = [V(v-) + swingLow, V(v+) + swingHigh],   ymid = (ylo + yhi)/2
```

- **Small signal**: `y/vd = aol/(1 + s·τ1)` — DC gain aol, unity-gain (gain × bandwidth)
  frequency gbw.
- **Slew rate**: |dy/dt| ≤ sr. The input stage is linear for |vd| ≲ sr/(2π·gbw).
- **Output swing (anti-windup)**: the gate `G = σ(P)·logistic((yhi − y)/δ + L) +
  (1 − σ(P))·logistic((y − ylo)/δ + L)` takes the drive away as y reaches the window, with L
  chosen so that, at full drive, the equilibrium sits on the window edge (δ = 5 mV). No
  stiff clamp, and recovery from saturation starts at once. The ramp term (zero inside the
  window) pulls y back if the rails move under it.
- **Second pole** (optional, `fp2` Hz): `τ2·dy2/dt = y − y2`, τ2 = 1/(2π·fp2). For a part, fp2
  is placed for the data's phase margin: r = tan(90° − PM), unity gain at fu = gbw/√(1+r²),
  fp2 = fu/r.
- **Output stage**: a Norton source `Iout = softLimit((y2 − V(out))/rout, iscSource,
  iscSink)` with `softLimit(x) = I·tanh(x/I)` per side (C2 at 0). The swing therefore drops
  with load: VOH = V+ + swingHigh − rout·Iout. Sourced current is drawn from `v+`, sunk
  current returned to `v-`.
- **Supply and inputs**: quiescent current `iq·tanh((V+ − V−)/0.5 V)` from `v+` to `v-`;
  bias currents `ib ± ios/2` into `inp`/`inn` (negative = out of the pins, PNP inputs),
  returned through `v-`.
- **AC**: the stamps are the Jacobian of the model at the operating point plus jω·τ terms,
  so a saturated or current-limited output has (almost) no gain.
- **Convergence**: every limit is smooth (tanh, logistic, C1 ramps). Newton limiting:
  tanh arguments may at most double per iteration unless both ends are deep in the same
  saturated tail; gate arguments take logarithmic steps on their exponential side (as
  pnjlim does); y is never evaluated more than 0.5 V outside the window; the gain-node row
  is equilibrated so it cannot steal a node's pivot. The supply-dependent parts (Vos, Ib,
  Iq) scale with source stepping.

Defaults (generic part): aol 1e5, gbw 1 MHz, sr 1 V/µs, fp2 0 (none), vos/ib/ios 0, swingHigh
−0.1 V, swingLow +0.1 V, rout 50 Ω, iscSource/iscSink 25 mA, iq 1 mA. Numeric params accept
unit strings (`gbw: '1M'`).

### Comparator (open collector)

Switching state s ∈ [0, 1] (internal unknown); s = 1 means the output transistor is on.

```
τc·ds/dt = (1/ωc)·R(D)·D·G(s) − (s − ½) − Gr·[ramp(s − 1 − 3δ) − ramp(−3δ − s)]
D = tanh(−κ·(vd + vos))       (the output goes LOW when V(inp) < V(inn) − vos)
I_sink = logistic((s − ½)/0.025)·isink·tanh(Vce/Vk) + gleak·Vce,   Vce = V(out) − V(emitter)
```

- **Response time**: s travels from a rail to ½ in 0.5/(R·tanh(κ·overdrive)). With
  `tpdFast` (response to a large step) κ = atanh(tpdFast/tpd)/overdrive, so the delay
  shrinks with overdrive; without it the delay is the same for any overdrive ≥ `overdrive`.
  Separate rates for the falling (tpdHL) and rising (tpdLH) output.
- **Gain**: ds/dvd at the threshold = avd/45 V (≈ 45 V of output per unit of s across the
  turn-on), so the input transition width is ≈ output swing / avd.
- **Saturation**: Vk = vol/atanh(iol/isink), so the output sinks `iol` at exactly `vol`
  and never more than `isink`. The emitter is `v-`, or the `emit` pin with
  `{ emitterPin: true }` (LM311).
- **Hysteresis** only comes from external resistors (no internal hysteresis is modelled).
- Push-pull comparator outputs are not modelled.

Defaults: avd 2e5, tpdHL = tpdLH = 1 µs at 5 mV overdrive, tpdFast 0, vol 0.2 V at 4 mA,
isink 16 mA, gleak 2e-11 S, iq 0.5 mA.

## Real parts

`Part(id)` returns ONE channel (dual packages: add one `Part()` per channel used; each
draws its own per-channel quiescent current). Ids are case-insensitive and aliases work
(`UA741` → LM741). `circuitsvibe catalog LM358` prints the derived parameters, a note per
derived value and per assumption, and the datasheet. Library: `opampPartParams(id)` /
`comparatorPartParams(id)` give the params, e.g. `new OpAmp({ ...opampPartParams('LM358'),
vos: 7e-3 })` for a worst-case offset (keeps `part`, so ratings are still checked).

Derivation rules (src/opamps/parts.ts): aol = 10^(Aol_dB/20) (typ); gbw, sr, vos, |ib|, ios
= typ; ib sign from the input type; swing: two 25 °C points at one supply and different
loads fit both the no-load offset and rout, one point is reproduced with rout = 50 Ω;
isc = typ source/sink; iq = typ supply current per channel; comparators: tpd from the 5 mV
overdrive response times, tpdFast from the large-step time, vol/iol from the saturation
spec, isink from the sink-current spec, gleak = leakage/VOH.

| Part | Package pins (channel A) | Model (derived) | Assumptions (no data) |
|------|------|------|------|
| LM358 | out 1, inn 2, inp 3, v- 4, v+ 8 | aol 1e5, gbw 0.7 MHz, sr 0.3 V/µs, vos 3 mV, ib −20 nA, swing V+ − 1.41 V / V− + 5 mV, isc 30/20 mA, iq 350 µA | rout 50 Ω; no phase margin → single pole |
| LM741 | inn 2, inp 3, v- 4, out 6, v+ 7 | aol 2e5, gbw 1.17 MHz (est. in data), sr 0.5 V/µs, vos 2 mV, ib 80 nA, swing ±0.73 V + rout 196 Ω (fit), isc 25 mA, iq 1.7 mA | PM 64.6° estimated from the 5 % overshoot → fp2 2.23 MHz |
| TL072 | out 1, inn 2, inp 3, v- 4, v+ 8 | aol 2e5, gbw 5.25 MHz, sr 20 V/µs, vos 3 mV, ib 65 pA, swing ±1.43 V, PM 56° → fp2 6.45 MHz, iq 1.4 mA | isc ±25 mA; rout 50 Ω |
| MCP6002 | out 1, inn 2, inp 3, v- 4, v+ 8 | aol 4e5, gbw 1 MHz, sr 0.6 V/µs, swing ±11 mV, isc 23 mA, iq 100 µA, PM 90° → single pole | vos 0 (only ±4.5 mV limits printed); rout 50 Ω |
| NE5532 | out 1, inn 2, inp 3, v- 4, v+ 8 | aol 1e5, gbw 12 MHz, sr 5 V/µs, vos 0.5 mV, ib 200 nA, isc 38 mA, iq 3 mA (6 mA / 2) | swing ±1 V (not in SLOS075K); single pole |
| LM393 | out 1, inn 2, inp 3, v- 4, v+ 8 | avd 2e5, vos 2 mV, ib −25 nA, tpd 1.3 µs at 5 mV, tpdFast 0.3 µs, vol 0.13 V at 4 mA, isink 6 mA (min), gleak 2e-11 S, iq 225 µA | — |
| LM311 | emit 1, inp 2, inn 3, v- 4, out 7, v+ 8 | avd 2e5, vos 2 mV, tpdHL 165 ns, tpdLH 115 ns at 5 mV, vol 0.75 V at 50 mA, iq 4.1 mA | isink 100 mA; same delay for any overdrive; ib sign |

### Model vs datasheet (simulated)

Open loop with a 10 kΩ load, Vos/Ib zeroed; slew from a 30 %→60 %-of-supply follower step;
swing at 10 kΩ; short-circuit current into 0.01 Ω. Single 5 V supply for LM358/MCP6002,
±15 V otherwise. Comparators with the datasheet test loads (LM393: 5.1 kΩ to 5 V, 15 pF;
LM311: 500 Ω to 5 V, 5 pF), time to the output crossing 1.4 V.

| Part | Aol (dB) sim / data | unity gain sim · GBW data | PM sim / data | SR sim / data (V/µs) | VOH at 10 kΩ sim / data | Isc sim / data | Iq sim / data |
|------|------|------|------|------|------|------|------|
| LM358 | 100.0 / 100 | 0.697 MHz · 0.7 MHz | 90° / — | 0.298 / 0.3 | V+ − 1.43 V / ≥ V+ − 1.5 V (2 kΩ, 5 V) | 29.5 mA / 30 mA | 350 µA / 350 µA |
| LM741 | 105.9 / 106.0 | 1.04 MHz · 1.17 MHz (est.) | 65.0° / (5 % overshoot) | 0.490 / 0.5 | V+ − 1.00 V / V+ − 1 V | 24.9 mA / 25 mA | 1.70 mA / 1.7 mA |
| TL072 | 106.0 / 106.0 | 4.34 MHz · 5.25 MHz | 56.1° / 56° | 19.9 / 20 | V+ − 1.50 V / V+ − 1.5 V | 25.0 mA / — | 1.40 mA / 1.4 mA |
| MCP6002 | 112.0 / 112 | 0.995 MHz · 1 MHz | 90° / 90° | 0.597 / 0.6 | V+ − 36 mV / ≥ V+ − 25 mV (5.5 V, 0.27 mA) | 23.0 mA / 23 mA | 100 µA / 100 µA |
| NE5532 | 100.0 / 100 | 11.9 MHz · 12 MHz | 90° / — | 4.98 / 5 | V+ − 1.07 V / — | 38.0 mA / 38 mA | 3.00 mA / 3 mA (6 mA pkg) |

The unity-gain frequency of a two-pole part is below its GBW by design (fu = gbw/√(1+r²)).
The MCP6002 point is measured at 5 V with 10 kΩ to ground; the data point is at 5.5 V with
the load to VDD/2 (0.27 mA), where the model gives V+ − 25 mV by construction.

| Part | tHL at 5 mV overdrive sim / data | tLH at 5 mV sim / data | large step sim / data |
|------|------|------|------|
| LM393 | 1.21 µs / 1.3 µs | 1.47 µs / 1.3 µs | 0.30 µs / 0.3 µs (TTL step) |
| LM311 | 142 ns / 165 ns | 127 ns / 115 ns | 141 ns / — |

## Lint and ratings

Lint (before the solver): **F120** supply pins open/shorted, **F121** amplifier input with
no DC path, **F122** op-amp positive feedback only (warning), **F123** IdealOpAmp output
shorted / across an ideal source, **F124** open-collector output without pull-up (warning).
Amplifier inputs and supply pins carry no DC path; an op-amp output is a driven node.

Ratings of Part() devices at the DC operating point, in `stages.op.ratings` (a violation
fails the op stage, exit 1): **R420** supply over the absolute maximum, **R421** differential
input over the absolute maximum, **R422** output at ≥ 90 % of the short-circuit current,
**R423** input outside the common-mode range (a comparator: both inputs), **R424** input beyond
the absolute-maximum input voltage (rail-relative ratings only), **R425** supply below the
recommended minimum. Only the operating point is checked (not dc sweeps or transients).

## The Part() seam

`src/parts/factory.ts` exports `Part(id)`: it tries each resolver of `RESOLVERS` in turn
(today `[opampPart]`); a resolver returns a Component for the ids it owns and `undefined`
otherwise. Another device family adds its resolver to the list (or, if a `Part()` already
exists elsewhere, calls `opampPart(id)` first) — the merge is a one-line union. Part()
devices carry `partId` and `params.part`; ratings look the catalog entry up by that id.

## Known gaps

- No CMRR/PSRR, input noise, input resistance/capacitance, output capacitive-load
  interaction, phase reversal, or temperature dependence.
- The common-mode range is checked (R423), not modelled: outside it the model keeps working.
- Ratings are checked at the operating point only (not over DC sweeps or transients).
- Comparator: no push-pull output, no internal hysteresis, no strobe/balance pins (LM311);
  the LM311 delay does not shrink with overdrive (no data); the delay to a 1.4 V crossing
  depends on the pull-up/load like the real part, so the LM393 rising edge is ~13 % slower
  than the single printed figure.
- Dual parts are single channels: no package-level model with shared supply pins and pin
  numbers (the catalog shows the channel-A pin numbers).
- Macro-model parameters for missing data are stated assumptions (rout 50 Ω, TL072 isc,
  NE5532 swing, LM311 isink) — see `circuitsvibe catalog <part>`.
