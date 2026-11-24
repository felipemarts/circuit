import type { AssertionSpec, ParamSpec, ParamValue } from '../schema/types';

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
  /** Embedded text files (future: VHDL, firmware). Carried verbatim; ascending `path`. */
  sources?: CircuitSource[];
  /** Optional, viewer-only placement hints. Never affects simulation. */
  layout?: CircuitLayout;
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
  /** Origin location (`file:line` of the tb.add call). Informational; dropped from share links. */
  at?: string;
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
