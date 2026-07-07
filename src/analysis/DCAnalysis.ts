import type { Circuit } from '../core/Circuit';
import type { Node } from '../core/Node';
import { MNAMatrix } from '../solver/MNAMatrix';
import { NewtonRaphson } from '../solver/NewtonRaphson';

export interface DCResult {
  nodeVoltages: Map<Node, number>;
}

export class DCAnalysis {
  run(circuit: Circuit): DCResult {
    const { components, nodes } = circuit._discoverComponents();

    if (components.length === 0) {
      throw new Error('No components connected to ground');
    }

    // Assign node indices: ground = 0, others = 1..N
    let nodeIndex = 1;
    for (const node of nodes) {
      if (node.index !== 0) {
        node.index = nodeIndex++;
      }
    }
    const nodeCount = nodeIndex; // total nodes including ground

    // Assign voltage source indices via protocol
    let vsCount = 0;
    for (const comp of components) {
      const count = comp.getVSourceCount();
      if (count > 0) {
        comp.assignVSourceIndices(vsCount);
        vsCount += count;
      }
    }

    // Check for nonlinear components
    const hasNonlinear = components.some(c => c.isNonlinear());

    let solution: number[];

    if (hasNonlinear) {
      solution = NewtonRaphson.solve(nodeCount, vsCount, components);
    } else {
      const matrix = new MNAMatrix(nodeCount, vsCount);
      for (const comp of components) {
        comp.stamp(matrix);
      }
      solution = matrix.solve();
    }

    // Build result and push results to components
    const nodeVoltages = new Map<Node, number>();
    const matrix = new MNAMatrix(nodeCount, vsCount); // for reading voltages

    for (const node of nodes) {
      const v = matrix.getNodeVoltage(solution, node.index);
      nodeVoltages.set(node, v);
    }

    // Update component results via protocol
    for (const comp of components) {
      const result = comp.readResults(solution, matrix);
      if (result) {
        comp._setResults(result.voltage, result.current);
      }
    }

    // Reset node indices for potential re-analysis
    for (const node of nodes) {
      if (node.index !== 0) node.index = -1;
    }

    return { nodeVoltages };
  }
}
