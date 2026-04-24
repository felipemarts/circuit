import type { Component } from '../core/Component';
import { MNAMatrix } from './MNAMatrix';

export interface NonlinearComponent {
  isNonlinear(): boolean;
  setOperatingPoint(solution: number[], matrix: MNAMatrix): void;
  getOperatingVoltage(): number;
}

function isNonlinearComponent(comp: Component): comp is Component & NonlinearComponent {
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

      // Check convergence: compare solution voltage with operating point
      if (solution) {
        let converged = true;

        for (const comp of components) {
          if (isNonlinearComponent(comp)) {
            const opV = comp.getOperatingVoltage();
            // Use readResults to get the actual voltage from solution
            const result = comp.readResults(newSolution, matrix);
            const solutionV = result ? result.voltage : 0;

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
