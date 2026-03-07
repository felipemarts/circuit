import type { Circuit } from '../core/Circuit';
import type { Component } from '../core/Component';
import type { Node } from '../core/Node';
import { MNAMatrix } from '../solver/MNAMatrix';
import { VoltageSource } from '../components/VoltageSource';
import { Inductor } from '../components/Inductor';
import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
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

    // Assign voltage source indices (VoltageSource and Inductor both use extra MNA variables)
    let vsCount = 0;
    for (const comp of components) {
      if (comp instanceof VoltageSource) {
        comp._vsIndex = vsCount++;
      } else if (comp instanceof Inductor) {
        comp._vsIndex = vsCount++;
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

    // Update component results
    for (const comp of components) {
      if (comp instanceof TwoTerminalComponent) {
        const v1 = matrix.getNodeVoltage(solution, comp._n1Index);
        const v2 = matrix.getNodeVoltage(solution, comp._n2Index);
        const voltage = v1 - v2;

        let current: number;
        if (comp instanceof VoltageSource) {
          current = matrix.getVSourceCurrent(solution, comp._vsIndex);
        } else if (comp instanceof Inductor) {
          current = matrix.getVSourceCurrent(solution, comp._vsIndex);
        } else {
          // For resistors: I = V/R, for others derive from voltage
          current = this.computeCurrent(comp, voltage);
        }

        comp._setResults(voltage, current);
      }
    }

    // Reset node indices for potential re-analysis
    for (const node of nodes) {
      if (node.index !== 0) node.index = -1;
    }

    return { nodeVoltages };
  }

  private computeCurrent(comp: TwoTerminalComponent, voltage: number): number {
    // Import dynamically avoided — use duck typing
    if ('resistance' in comp) {
      return voltage / (comp as { resistance: number }).resistance;
    }
    if ('currentValue' in comp) {
      return (comp as { currentValue: number }).currentValue;
    }
    if ('computeDiodeCurrent' in comp) {
      return (comp as { computeDiodeCurrent(v: number): number }).computeDiodeCurrent(voltage);
    }
    return 0;
  }
}
