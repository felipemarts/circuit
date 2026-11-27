import type { AssertionSpec, ParamSpec, ParamValue } from '../schema/types';
import type { PcbSpec } from '../pcb/types';

/**
 * The circuit document `circuitsvibe-circuit/1` — the language-neutral,
 * plain-JSON description of a bench: components + wiring, free parameters,
 * assertions (with their analysis configs), and optional metadata, embedded
 * source files and viewer layout. Specified in docs/CIRCUIT-FORMAT.md and
 * schema/circuit.schema.json. Every producer (the TypeScript bench DSL, a
 * future Python library, the web viewer) writes exactly this shape.
 *
 * Field shapes deliberately mirror the RunRecord `netlist` (components with
 * `id`/`type`/`params`/`pins`/`free`/`at`) and `AssertionSpec`.
 */

/** Schema identifier of this document version. */
export const CIRCUIT_SCHEMA = 'circuitsvibe-circuit/1';

export interface CircuitDoc {
  schema: typeof CIRCUIT_SCHEMA;
  /** Bench name (becomes RunRecord.bench). */
  name: string;
  meta?: CircuitMeta;
  /** Components; canonical order is ascending `id`. */
  components: CircuitComponent[];
  /**
   * User-named nets (the ones probes may cite), ascending. Every net name used
   * in `components[].pins` is `gnd`, an anonymous `n<digits>`, or listed here.
   */
  nets?: string[];
  /** Assertions in declaration order (ids a1, a2, … from the DSL). */
  assertions: AssertionSpec[];
  /**
   * Scalar overrides (`--set`) that were applied when the document was made.
   * Component `params` ALREADY contain the overridden values; this field only
   * records them so a verify reports the same `overrides` as the bench run.
   */
  overrides?: Record<string, number>;
  /**
   * Datasheet-rating check settings (`tb.ratings(...)`) when they differ from
   * the defaults (`{ enabled: true, derate: 1, pd: 'average', ignore: [] }`);
   * only the non-default keys are written. Absent = defaults.
   */
  ratings?: CircuitRatings;
  /** Embedded text files (VHDL, firmware, custom-component modules). Carried verbatim; ascending `path`. */
  sources?: CircuitSource[];
  /**
   * Custom components (`defineComponent` parts) used by `components[].type`,
   * ascending `type`. Their code is a module in `sources`; simulating the
   * document evaluates it (the CLI only with --allow-code). See docs/CIRCUIT-FORMAT.md.
   */
  definitions?: CircuitDefinition[];
  /** Optional, viewer-only placement hints. Never affects simulation. */
  layout?: CircuitLayout;
  /**
   * The printed circuit board (`tb.board` / `tb.place`): board outline and
   * rules, placement per component id, custom footprints. Lengths in mm.
   * Never affects simulation; drives the pcb stage. See docs/PCB.md.
   */
  pcb?: PcbSpec;
}

/** `tb.ratings({...})` as data (R401–R404 checks of Part() semiconductors). */
export interface CircuitRatings {
  /** false: no rating checks at all (`tb.ratings(false)`). */
  enabled?: boolean;
  /** Multiply every absolute maximum by this factor, 0 < derate ≤ 1. */
  derate?: number;
  /** How Pd is compared in the transient stage. */
  pd?: 'average' | 'peak';
  /** Component ids excluded from the checks (ascending, unique). */
  ignore?: string[];
}

export interface CircuitMeta {
  title?: string;
  description?: string;
  author?: string;
}

export interface CircuitComponent {
  /** Stable id (`/^[A-Za-z][A-Za-z0-9_]*$/`), unique in the document. */
  id: string;
  /** Component type: a built-in engine type (`circuitsvibe catalog`) or the name of a custom definition passed by the caller. */
  type: string;
  /** Plain-JSON configuration, exactly as in the RunRecord netlist (SI units). */
  params: Record<string, ParamValue>;
  /** Canonical pin name → net name. Every pin of the type is listed. */
  pins: Record<string, string>;
  /** Free parameter declared with tb.param (sweep range for verified hints). */
  free?: ParamSpec;
  /**
   * The verbatim SPICE `.model` card of a semiconductor built with
   * `<Type>.fromModel(card)` (Diode, LED, NPN, PNP, NMOS, PMOS). Re-read on load
   * to reproduce the card's lint diagnostics (T005–T008); the electrical values
   * are those of `params`, whose `model` must name the same card.
   */
  modelCard?: string;
  /** Origin location (`file:line` of the tb.add call). Informational; dropped from share links. */
  at?: string;
}

export interface CircuitDefinition {
  /** Component type: the ComponentDef `name`, used by `components[].type`. */
  type: string;
  /** The definition's pin names, in order (checked against the code when it runs). */
  pins: string[];
  /** Path of the module in `sources` that exports the definition. */
  source: string;
  /** Export name (default: the default export). */
  export?: string;
  /** Registry provenance: the published `<user>/<name>@<version>` and the SHA-256 of its source. */
  registry?: { ref: string; hash: string };
}

export interface CircuitSource {
  /** Relative POSIX path, e.g. `rtl/counter.vhd`, `firmware/blink.fw.ts`. Unique. */
  path: string;
  /** Lowercase language tag, e.g. `vhdl`, `typescript`, `text`. */
  language: string;
  text: string;
}

export interface CircuitLayout {
  /** Placement per component id. */
  components?: Record<string, ComponentPlacement>;
  /** Wire drawing hints between two pins on the same net. */
  wires?: WireHint[];
  /** Viewer-owned extension fields are allowed. */
  [key: string]: unknown;
}

export interface ComponentPlacement {
  x: number;
  y: number;
  /** Degrees clockwise. */
  rotation?: 0 | 90 | 180 | 270;
  /** Mirror horizontally (before rotation). */
  flip?: boolean;
  [key: string]: unknown;
}

export interface WireHint {
  /** Pin ref `id.pin`. */
  from: string;
  /** Pin ref `id.pin` on the same net as `from`. */
  to: string;
  /** Intermediate waypoints `[x, y]`, in viewer coordinates. */
  points?: [number, number][];
  [key: string]: unknown;
}
