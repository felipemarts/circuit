import type { Circuit } from '../core/Circuit';
import type { Component } from '../core/Component';
import { MNAMatrix } from '../solver/MNAMatrix';
import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import { NewtonRaphson } from '../solver/NewtonRaphson';

export interface TransientConfig {
  timeStep: number;
  duration: number;
}

export interface ProbeSpec {
  label: string;
  color: string;
  component?: Component;
  type: 'voltage' | 'current';
}

export interface TransientResult {
  timePoints: number[];
  probes: { label: string; color: string; values: number[] }[];
}

/** Throws on configs that would hang (timeStep=0), run backwards, or NaN-poison results. */
export function validateTransientConfig(config: TransientConfig): void {
  if (!Number.isFinite(config.timeStep) || config.timeStep <= 0) {
    throw new Error(`invalid transient timeStep ${config.timeStep}: must be a finite number > 0`);
  }
  if (!Number.isFinite(config.duration) || config.duration <= 0) {
    throw new Error(`invalid transient duration ${config.duration}: must be a finite number > 0`);
  }
}

export class TransientAnalysis {
  run(circuit: Circuit, config: TransientConfig, probeSpecs: ProbeSpec[]): TransientResult {
    validateTransientConfig(config);
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
    const nodeCount = nodeIndex;

    // --- Phase 1: DC operating point ---
    let vsCount = 0;
    for (const comp of components) {
      const count = comp.getVSourceCount();
      if (count > 0) {
        comp.assignVSourceIndices(vsCount);
        vsCount += count;
      }
    }

    // Resolve probe node indices now that nodes are assigned
    const probeNodeIndices = probeSpecs.map(spec => {
      if (spec.component && spec.component instanceof TwoTerminalComponent) {
        return spec.component._n1Index;
      }
      // For multi-pin components, use first pin
      if (spec.component) {
        const pins = spec.component.allPins();
        if (pins.length > 0) return pins[0].node.index;
      }
      return 0;
    });

    const hasNonlinear = components.some(c => c.isNonlinear());
    let dcSolution: number[];

    if (hasNonlinear) {
      dcSolution = NewtonRaphson.solve(nodeCount, vsCount, components);
    } else {
      const matrix = new MNAMatrix(nodeCount, vsCount);
      for (const comp of components) {
        comp.stamp(matrix);
      }
      dcSolution = matrix.solve();
    }

    // --- Phase 2: Switch to transient mode ---
    // Each component switches itself to transient mode via prepareTransientStep
    for (const comp of components) {
      comp.prepareTransientStep(0); // dt=0 signals "enter transient mode"
    }

    // Reassign vsource indices for transient (some components like Inductor drop their vsource)
    let transientVsCount = 0;
    for (const comp of components) {
      const count = comp.getVSourceCount();
      if (count > 0) {
        comp.assignVSourceIndices(transientVsCount);
        transientVsCount += count;
      }
    }

    // --- Phase 3: Time stepping loop ---
    const dt = config.timeStep;
    const numSteps = Math.ceil(config.duration / dt);
    const timePoints: number[] = [];
    const probeValues: number[][] = probeSpecs.map(() => []);

    for (let step = 0; step <= numSteps; step++) {
      const t = step * dt;
      timePoints.push(t);

      // Update time-dependent sources
      for (const comp of components) {
        comp.setTime(t);
      }

      // Set companion model parameters
      for (const comp of components) {
        comp.prepareTransientStep(dt);
      }

      // Build and solve
      let solution: number[];
      if (hasNonlinear) {
        solution = NewtonRaphson.solve(nodeCount, transientVsCount, components);
      } else {
        const matrix = new MNAMatrix(nodeCount, transientVsCount);
        for (const comp of components) {
          comp.stamp(matrix);
        }
        solution = matrix.solve();
      }

      const readMatrix = new MNAMatrix(nodeCount, transientVsCount);

      // Record probe values
      for (let i = 0; i < probeSpecs.length; i++) {
        const probe = probeSpecs[i];
        if (probe.component) {
          const result = probe.component.readResults(solution, readMatrix);
          if (probe.type === 'voltage') {
            if (result) {
              probeValues[i].push(result.voltage);
            } else {
              const nodeIdx = probeNodeIndices[i];
              probeValues[i].push(readMatrix.getNodeVoltage(solution, nodeIdx));
            }
          } else if (probe.type === 'current') {
            if (result) {
              probeValues[i].push(result.current);
            } else {
              probeValues[i].push(0);
            }
          }
        }
      }

      // Update state for next timestep
      for (const comp of components) {
        comp.updateState(solution, readMatrix);
      }
    }

    // Reset components to DC mode
    for (const comp of components) {
      comp.resetToDC();
    }

    // Reset node indices
    for (const node of nodes) {
      if (node.index !== 0) node.index = -1;
    }

    return {
      timePoints,
      probes: probeSpecs.map((spec, i) => ({
        label: spec.label,
        color: spec.color,
        values: probeValues[i],
      })),
    };
  }
}
