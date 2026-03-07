import type { Component } from '../core/Component';
import { MNAMatrix } from './MNAMatrix';
import { TwoTerminalComponent } from '../core/TwoTerminalComponent';

export interface NonlinearComponent {
  isNonlinear(): boolean;
  setOperatingPoint(solution: number[], matrix: MNAMatrix): void;
  getOperatingVoltage(): number;
}

function isNonlinearComponent(comp: Component): comp is Component & NonlinearComponent & TwoTerminalComponent {
  return comp.isNonlinear();
}

export class NewtonRaphson {
  static solve(
    nodeCount: number,
    vsCount: number,
    components: Component[],
    maxIterations: number = 200,
    absTol: number = 1e-6,
  ): number[] {
    const matrix = new MNAMatrix(nodeCount, vsCount);
    let solution: number[] | null = null;

    for (let iter = 0; iter < maxIterations; iter++) {
      matrix.clear();

      // Set operating points from previous solution
      if (solution) {
        for (const comp of components) {
          if (isNonlinearComponent(comp)) {
            comp.setOperatingPoint(solution, matrix);
          }
        }
      }

      // Stamp all components
      for (const comp of components) {
        comp.stamp(matrix);
      }

      const newSolution = matrix.solve();

      // Check convergence: the solution's nonlinear device voltages
      // must match their operating points
      if (solution) {
        let converged = true;

        for (const comp of components) {
          if (isNonlinearComponent(comp)) {
            const v1 = matrix.getNodeVoltage(newSolution, comp._n1Index);
            const v2 = matrix.getNodeVoltage(newSolution, comp._n2Index);
            const solutionV = v1 - v2;
            const opV = comp.getOperatingVoltage();

            if (Math.abs(solutionV - opV) > absTol) {
              converged = false;
              break;
            }
          }
        }

        if (converged) return newSolution;
      }

      solution = newSolution;
    }

    throw new Error(`Newton-Raphson did not converge after ${maxIterations} iterations`);
  }
}
