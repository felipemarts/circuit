import type { Elaboration } from '../elab/bench';
import { layoutBoard } from '../pcb/layout';
import type { StageOutcome } from './op';

/**
 * L4: pcb — the board of a bench that declares one (tb.board). Resolves
 * footprints and pin → pad maps, checks the placement (P801–P807) and
 * records the ratsnest. Errors are structural (exit 2): the board cannot be
 * built as laid out.
 */
export function runPcb(elab: Elaboration): StageOutcome {
  const layout = layoutBoard(elab.pcb!, elab.netlist.components, elab.pcbLocs ?? {});
  const hasErrors = layout.diagnostics.some(d => d.severity === 'error');
  return {
    stage: { verdict: hasErrors ? 'error' : 'pass', pcb: layout.record },
    diagnostics: layout.diagnostics,
  };
}
