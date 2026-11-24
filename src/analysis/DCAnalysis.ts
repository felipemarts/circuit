import type { Circuit } from '../core/Circuit';
import type { Node } from '../core/Node';
import { SimulationSystem, type OpTelemetry } from './engine';

export interface DCResult {
  nodeVoltages: Map<Node, number>;
  /** Solver telemetry: method, iterations, convergence aids used. */
  telemetry: OpTelemetry;
  /** Raw solution vector (node voltages then branch currents, in engine order). */
  solution: number[];
}

export class DCAnalysis {
  run(circuit: Circuit, opts: { x0?: ArrayLike<number> } = {}): DCResult {
    const system = new SimulationSystem(circuit);
    try {
      const x0 = opts.x0 && opts.x0.length === system.size ? Float64Array.from(opts.x0) : undefined;
      const { x, telemetry } = system.operatingPoint(x0);
      const nodeVoltages = new Map<Node, number>();
      for (const node of system.nodes) {
        nodeVoltages.set(node, node.index > 0 ? x[node.index - 1] : 0);
      }
      system.publish(x);
      return { nodeVoltages, telemetry, solution: Array.from(x) };
    } finally {
      system.release();
    }
  }
}
