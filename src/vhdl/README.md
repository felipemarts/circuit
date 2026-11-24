# src/vhdl — synthesizable VHDL on the digital engine

Compiles a practical synthesizable subset of VHDL (IEEE 1076-2008 flavored, `std_logic_1164`
+ `numeric_std`) onto the event-driven digital engine in `src/digital`, so digital logic can be
written in VHDL and simulated — later together with analog circuits through the engine's
co-simulation API. Pure TypeScript, zero dependencies, browser-safe (no Node APIs),
deterministic. **Not yet exported from `src/forge.ts`** (integration step pending).

```
source.ts       VhdlSource, source locations (file:line:col / bench line + vhdl line:col)
diagnostics.ts  VHDL_CODES (V701–V755), VhdlDiagnostic, VhdlError
lexer.ts        tokens (case-insensitive ids, based / bit-string / physical literals)
parser.ts       recursive-descent parser → ast.ts; first error per design unit, V703 for known-unsupported syntax
printer.ts      AST → canonical VHDL (round-trip tests, debugging)
types.ts        elaboration types (std_logic, vectors, integer subtypes, enums, boolean, time)
elab.ts         elaboration: generics, signals → per-bit nets, processes → JSON IR, hierarchy, generate
ir.ts           the JSON IR of one process (the `config` of a digital Behavioral part)
runtime.ts      IR → closures; the process Model (VHDL signal/variable semantics); static evaluation
values.ts       std_logic tables, numeric_std arithmetic (BigInt), the std_logic ↔ net mapping
design.ts       public API: compileVhdl, instantiateVhdl, VhdlDesign, VhdlInstance, parseVhdl
```

## Example

```ts
import { DigitalCircuit, Clock, Stimulus, dutyCycle } from '../digital';
import { compileVhdl, instantiateVhdl } from '../vhdl';

const pwmVhd = `
library ieee; use ieee.std_logic_1164.all;
entity pwm is
  generic (PERIOD : positive := 10; DUTY : natural := 3);
  port (clk, rst : in std_logic; pwm_out : out std_logic);
end entity;
architecture rtl of pwm is
  signal cnt : natural range 0 to PERIOD - 1 := 0;
begin
  process (clk) begin
    if rising_edge(clk) then
      if rst = '1' or cnt = PERIOD - 1 then cnt <= 0; else cnt <= cnt + 1; end if;
    end if;
  end process;
  pwm_out <= '1' when cnt < DUTY else '0';
end architecture;`;

const { ok, design, diagnostics } = compileVhdl(pwmVhd);   // never throws for VHDL errors
if (!ok) console.log(diagnostics);                          // V7xx with at / message / note / fixes

const c = new DigitalCircuit();
c.add('CK', new Clock({ freq: '100M' }), { y: 'CLK' });
c.add('SR', new Stimulus({ initial: 0 }), { y: 'RST' });
const u1 = design!.instantiate(c, 'U1', { generics: { DUTY: 4 }, ports: { clk: 'CLK', rst: 'RST', pwm_out: 'PWM' } });
// or in one call (throws VhdlError with .diagnostics): instantiateVhdl(c, 'U1', pwmVhd, { … })

c.lint();                       // digital lint (F13x) — VHDL processes report their VHDL line in `at`
const sim = c.build();
sim.advanceTo('2u');
dutyCycle(sim.trace('PWM'));    // 0.4
u1.read(sim, 'cnt');            // integer value of an internal signal
u1.port('pwm_out').nets;        // ['PWM']
```

Tested example designs (with hand-computed expected traces) are in `tests/vhdl/designs/`:
`counter.vhd` (N-bit counter, sync reset, enable), `pwm.vhd` (generic duty), `uart_tx.vhd`
(8N1 transmitter), `traffic_light.vhd` (FSM with `after` delays), `debounce.vhd`.

In a bench file, `import counter from './counter.vhd'` (also `.vhdl`; the extension is required)
yields a frozen `{ kind: 'vhdl-source', text, path }` with `path` relative to the working
directory, so diagnostics read `rtl/counter.vhd:12:5` (src/cli/load.ts). For editor types add
`declare module '*.vhd' { const src: { kind: 'vhdl-source'; text: string; path: string }; export default src; }`.

## API

| Function / member | |
|---|---|
| `compileVhdl(input, { origin? })` | `input`: VHDL text, `{ text, path? }`, or an array of them (one compilation unit, library `work`). Returns `{ ok, design?, diagnostics }`. Syntax is checked for every source; entities whose generics all have defaults are also elaborated to report semantic errors early. |
| `compileVhdlOrThrow(input)` | same, throws `VhdlError` (`.diagnostics`) on errors |
| `parseVhdl(input)` | AST + syntax diagnostics only; `printVhdl(file)` prints an AST back |
| `design.entities()` / `design.topEntities()` | entity info (generics, ports as written, architectures) / entities nobody instantiates |
| `design.elaborate(id, opts)` | elaborate without a circuit → `{ ok, result?, diagnostics }` |
| `design.instantiate(circuit, id, opts)` | add to a `DigitalCircuit`; throws `VhdlError` |
| `instantiateVhdl(circuit, id, designOrSource, opts)` | compile if needed + instantiate |

`opts`: `entity` (default: the only top-level entity), `architecture` (default: the last one
compiled), `generics` (integers as numbers, booleans, time as seconds or `'10 ns'` / `'10n'`,
std_logic as `'1'`, vectors as `"0101"`), `ports` (port → net, see below).

`VhdlInstance`: `ports` (`name, mode, type, kind, width, nets, range?, signed?, low?, high?,
literals?`), `port(name)`, `net(port, index?)`, `signals` (every signal incl. hierarchical
`u1.carry`, `g(2).fa.s`), `read(sim, name)`, `readNumber(sim, name)`, `components` (ids added),
`generics`, `diagnostics` (warnings such as V717).

### Ports, nets and naming

- **Port mapping**: a string is a base name — std_logic/boolean ports use it as is, vectors get
  `base[i]` per VHDL index `i`, integer/enum ports `base[k]` per encoding bit (LSB 0). An array
  lists the nets from the lowest index (or LSB) up. Unmapped ports get `<id>__<port>…`; an
  unmapped **input with a default** (`en : in std_logic := '1'`) is tied to the default (a Const),
  one without a default is an undriven net (digital lint F130 until something drives it).
- `port.nets` is always ordered from the lowest index / LSB up — the bridge points for a later
  analog integration (`sim.drive(net, …)` for A→D, `sim.onChange` / traces for D→A).
- Internal signals: nets `<id>__<signal>` (`U1__count[3]`), hierarchy `U1__fa0__c`, generate
  `U1__g[2]__fa__s`. Components: one `Behavioral` per process / concurrent assignment /
  concurrent assert, id `<id>__<label>` or `<id>__process_<line>` / `assign_<line>` /
  `assert_<line>` when unlabeled (`U1__fa0__assign_10`), plus Consts named `…__init` / `…__const`.
- Encodings: `integer range 0 to 9` → 4 nets, ranges with negatives → two's complement,
  `integer` → 32 nets, `natural` → 31; enumerations → ⌈log2 n⌉ nets (position number);
  boolean → 1 net. The netlist is plain JSON (`c.netlist()` rebuilds with `new DigitalSim(json)`
  once `registerVhdlBehavior()` ran, which `instantiate` does).

## std_logic ↔ engine mapping

The engine has 4 values (0, 1, X, Z) with strong/weak strength. Inside a process values are full
9-valued std_logic with the IEEE 1164 operator tables; at the nets:

| VHDL drives | net driver | | net value | VHDL reads |
|---|---|---|---|---|
| `'0'` / `'1'` | strong 0 / 1 | | 0 / 1 | `'0'` / `'1'` |
| `'L'` / `'H'` | weak 0 / 1 (pull) | | X | `'X'` |
| `'W'` | weak X | | Z | `'Z'` |
| `'Z'` | released (Z) | | | |
| `'U'` `'X'` `'-'` | strong X | | | |

So `'U'` (the default of an uninitialized std_logic) reads back as `'X'`; `'H'`/`'L'` read as
`'1'`/`'0'`. Several drivers of a resolved signal (std_logic, std_logic_vector, unsigned,
signed) are resolved by the engine: `'Z'` yields, weak loses to strong, strong 0 vs 1 → X plus
the engine's **D501** (weak vs weak → D507). Unresolved types with several drivers are V714.

## Simulation semantics

- A process resumes when a signal of its sensitivity list has an event (any read signal for
  `process(all)` and concurrent statements). At initialization every process runs once, except
  one whose first statement is `wait until …`.
- Signal reads return the current resolved values; assignments are scheduled per driver after
  the process run — zero delay = next delta cycle, **the last assignment to a driver within a run
  wins**; variables update immediately and keep their value between activations. Swapping
  signals in one process works.
- `y <= x after 5 ns` is an inertial delay (pulses shorter than the delay are swallowed).
  The engine's power-on settle (t = 0) applies zero-delay assignments immediately; assignments
  with `after` made at initialization are scheduled at `0 + delay`.
- `rising_edge(s)` = an event with previous value 0 and current value 1 at the net level
  (`'H'` counts as 1); `s'event` = any bit of `s` changed in this delta. No edges during the
  power-on settle (engine contract).
- numeric_std: arithmetic results are modulo the result width (`+`/`-`: longest operand,
  `*`: sum of widths, vector `op` natural: vector width; `u * n`: 2× width); metavalues (U/X/Z/W/-)
  give all-X results, false comparisons, `to_integer` = 0 (V753 warning, suppressed at t = 0).
  Integers do **not** wrap: leaving a subtype range is V751 and the assignment is skipped.
- Runtime errors never stop the simulation: out-of-range index (V750: read X / write skipped),
  range violation (V751), assert/report (V752), metavalue (V753), division by zero (V754),
  X bits on an integer/enum/boolean signal (V755). Each carries process, time and VHDL location.

## Supported subset

| Area | Supported (all tested in tests/vhdl) |
|---|---|
| Context | `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;` (checked: missing clause → V707); `std`, `work` libraries |
| Design units | several entities/architectures per source and across sources; last architecture wins; `entity work.e(arch)` |
| Generics | `integer`/`natural`/`positive`/subtypes, `boolean`, `time`, std_logic / vector constants; defaults; generic maps (named/positional) |
| Ports | `in`, `out`, `inout`, `buffer`; `std_logic`/`std_ulogic`, `std_logic_vector`/`std_ulogic_vector`/`unsigned`/`signed` `(N downto 0 / 0 to N)`, `integer range …`, `boolean`, enumeration; defaults; output ports may be read (2008) |
| Declarations | `signal`, `constant` (also unconstrained, length from value), `variable` (process), `type … is (A, B, C)`, `subtype`, `component`; initial values |
| Concurrent | simple, conditional (`when … else`, `unaffected`), selected (`with … select`) assignments; `process (list)` / `process (all)` / process starting with `wait until`; `assert`; entity and component instantiation (named, positional, `open`, constant actuals, indexed/sliced actuals); `for … generate` (with local signals), `if … generate` / `elsif` / `else` |
| Sequential | signal `<=` (incl. `after`, 2008 `when … else`), variable `:=`, `if/elsif/else`, `case … when … | … / ranges / others`, `for … in a to b / downto / x'range / enum type loop`, `exit` / `next` [label] [`when`], `null`, `assert … report … severity`, `report` |
| Expressions | `and or nand nor xor xnor not` (std_logic, boolean, vectors), reduction `and v` / `or v` / `xor v`, `= /= < <= > >=`, `+ - * / mod rem ** abs` (integer), numeric_std `+ - * / mod rem` and comparisons on unsigned/signed (also with naturals/integers), unary `-`/`abs` on signed, `&`, `sll srl rol ror`, `??`, indexing (static or dynamic), static slices, aggregates `(others => …)`, `(i => …, a downto b => …)`, positional; qualified expressions `t'(…)`; type conversions `unsigned()`, `signed()`, `std_logic_vector()`, `integer()`/subtypes |
| Functions | `rising_edge`, `falling_edge`, `to_unsigned`, `to_signed`, `to_integer`, `resize`, `shift_left`, `shift_right`, `rotate_left`, `rotate_right`, `to_string`; sizes may be `x'length` or (2008) a vector |
| Attributes | `'event`; vectors `'length 'left 'right 'high 'low 'range 'reverse_range 'ascending`; integer types `'high 'low 'left 'right 'image`; enumerations `'pos 'val 'succ 'pred 'left 'right 'high 'low 'image` |
| Literals | `'0'…`, `"0101"`, `x"FF"`, `o"17"`, `b"1010_0101"`, `8x"F"`, based `16#FF#`, `10 ns` / `1.5 us` |

**Not supported** (each is a clear V703/V708 naming the construct and the supported set —
never silently ignored): `wait for`/`wait on`/bare `wait` and `wait until` anywhere but as the
first statement of a sensitivity-less process; `while`/bare loops; `transport`/`reject`
delays; multi-element waveforms; user functions/procedures; packages and `use work.pkg`;
records, array types (memories), multi-dimensional arrays; `real`, `bit`/`bit_vector`,
`character`; file I/O and `std.textio`; `std_logic_arith`/`std_logic_unsigned` (use
`numeric_std`); signal attributes other than `'event`; shared variables, aliases, attributes,
blocks, configurations, case-generate, matching operators (`?=`, `case?`); expressions other
than constants in port maps; partial port associations (`q(0) => …`); dynamic slice bounds.

## Diagnostics

Every user error is a `VhdlDiagnostic` (structurally a platform `Diagnostic`, like
`DigitalDiagnostic`): `code`, `slug`, `severity`, `stage` (`lint` for V701–V749, `tran` for
V750–V799), `message`, `at`, `note`, `evidence`, `fixes[]` with `confidence`
(`mechanical` = deterministic rewrite, `suggested` = heuristic; no fix is `verified`). All codes
are in `src/verify/registry.ts` (`circuitsvibe explain V7xx`) and docs/DIAGNOSTICS.md.

`at`: `path:line:col` for a source with a path; `<caller file:line> (vhdl line:col)` for inline
text (the caller is the line that called `compileVhdl` / `instantiateVhdl`, or `{ origin }`).

| Code | | Code | |
|---|---|---|---|
| V701 syntax error (first per unit, exact line:col) | | V713 must be static | |
| V702 lexical error | | V714 unresolved signal, several drivers | |
| V703 unsupported construct | | V715 duplicate declaration | |
| V704 undeclared (did-you-mean) | | V716 process without sensitivity/wait | |
| V705 type mismatch (fix = conversion) | | V717 incomplete sensitivity list (warning) | |
| V706 length mismatch | | V718 case/select coverage, duplicate choices | |
| V707 missing library/use clause | | V719 static index/slice/range | |
| V708 unsupported library/package | | V720 invalid literal (`'x'`) | |
| V709 unknown entity/architecture | | V721 instantiate() API misuse | |
| V710 port map | | V722 recursive instantiation | |
| V711 generic value / map | | V723 entity without architecture | |
| V712 illegal assignment target | | V750–V755 runtime (see above) | |

## Digital-engine changes made for this module

- `Behavioral` part + `registerBehavior(name, factory)` (src/digital/behavior.ts): pins and
  model from a registered factory, plain-JSON params (`behavior`, `inputs`, `outputs`,
  `combPaths`, `config`), outputs lint as tri-state, 0-delay inertial drivers.
- `Host.out(driver, drive, delayTicks?)`: per-transaction delay.
- `DigitalCircuit.add(id, part, wiring, { at })`: per-part source location; `fromJSON` keeps `at`.

## Integration notes / known gaps

- Not exported from `src/forge.ts`; benches cannot reach it through `'circuitsvibe'` yet.
- Lint: each process declares comb paths from its sensitivity inputs to the outputs it assigns
  outside clock-edge branches (with the static `after` delay), so F133 finds zero-delay VHDL
  loops; clocked processes have none.
- Elaboration is per instance: two instances of one entity compile twice (fine for typical
  designs; very large generate loops are capped at 4096 iterations).
- `after` delays are inertial only; the reject window equals the delay.
- Integer subtypes connected across a port map must have identical ranges (they are carried on
  nets); `integer`/`natural` ports cost 32/31 nets — prefer constrained ranges or vectors.
- No timing checks (setup/hold) inside VHDL processes; use the engine's DFF parts for that.
- The 9-valued `'U'` is not preserved on nets (it reads back as `'X'`).
