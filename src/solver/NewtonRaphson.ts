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

/** Telemetry captured when Newton-Raphson fails, so callers can name a culprit. */
export interface NRTelemetry {
  iterations: number;
  /** Component with the largest voltage delta on the final iteration. */
  worst: {
    component: Component;
    /** |V(solution) - V(operating point)| on the last iteration. */
    deltaV: number;
    /** Solution voltages of the worst component over the last iterations (oldest first). */
    history: number[];
  } | null;
}

export class ConvergenceError extends Error {
  readonly telemetry: NRTelemetry;

  constructor(message: string, telemetry: NRTelemetry) {
    super(message);
    this.name = 'ConvergenceError';
    this.telemetry = telemetry;
  }
}

const HISTORY_LENGTH = 8;

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
    const nonlinear = components.filter(isNonlinearComponent);
    const history = new Map<Component, number[]>();
    let worst: NRTelemetry['worst'] = null;

    for (let iter = 0; iter < maxIterations; iter++) {
      matrix.clear();

      // Set operating points from previous solution
      if (solution) {
        for (const comp of nonlinear) {
          comp.setOperatingPoint(solution, matrix);
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
        worst = null;

        for (const comp of nonlinear) {
          const opV = comp.getOperatingVoltage();
          // Use readResults to get the actual voltage from solution
          const result = comp.readResults(newSolution, matrix);
          const solutionV = result ? result.voltage : 0;

          const h = history.get(comp) ?? [];
          h.push(solutionV);
          if (h.length > HISTORY_LENGTH) h.shift();
          history.set(comp, h);

          const deltaV = Math.abs(solutionV - opV);
          if (deltaV > absTol) {
            converged = false;
            if (!worst || deltaV > worst.deltaV) {
              worst = { component: comp, deltaV, history: h };
            }
          }
        }

        if (converged) return newSolution;
      }

      solution = newSolution;
    }

    throw new ConvergenceError(
      `Newton-Raphson did not converge after ${maxIterations} iterations`,
      { iterations: maxIterations, worst: worst && { ...worst, history: [...worst.history] } },
    );
  }
}
