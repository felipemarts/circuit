import type { Circuit } from '../core/Circuit';
import { MNAMatrix } from '../solver/MNAMatrix';
import { VoltageSource } from '../components/VoltageSource';
import { Inductor } from '../components/Inductor';
import { Capacitor } from '../components/Capacitor';
import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import { NewtonRaphson } from '../solver/NewtonRaphson';

export interface TransientConfig {
  timeStep: number;
  duration: number;
}

export interface ProbeSpec {
  label: string;
  color: string;
  component?: TwoTerminalComponent;
  type: 'voltage' | 'current';
}

export interface TransientResult {
  timePoints: number[];
  probes: { label: string; color: string; values: number[] }[];
}

export class TransientAnalysis {
  run(circuit: Circuit, config: TransientConfig, probeSpecs: ProbeSpec[]): TransientResult {
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
      if (comp instanceof VoltageSource) {
        comp._vsIndex = vsCount++;
        comp._effectiveVoltage = comp.declaredVoltage;
      } else if (comp instanceof Inductor) {
        comp._vsIndex = vsCount++;
      }
    }

    // Resolve probe node indices now that nodes are assigned
    const probeNodeIndices = probeSpecs.map(spec => {
      if (spec.component) {
        return spec.component._n1Index;
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

    // Initialize reactive components with zero state (cold start / step response)
    for (const comp of components) {
      if (comp instanceof Capacitor) {
        comp._prevVoltage = 0;
      } else if (comp instanceof Inductor) {
        comp._prevCurrent = 0;
      }
    }

    // --- Phase 2: Switch to transient mode ---
    let transientVsCount = 0;
    for (const comp of components) {
      if (comp instanceof VoltageSource) {
        comp._vsIndex = transientVsCount++;
      } else if (comp instanceof Inductor) {
        comp._transient = true;
        comp._vsIndex = -1;
      } else if (comp instanceof Capacitor) {
        comp._transient = true;
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
        if (comp instanceof VoltageSource) {
          comp._effectiveVoltage = comp.voltageAtTime(t);
        }
      }

      // Set companion model parameters
      for (const comp of components) {
        if (comp instanceof Capacitor) {
          comp.setTransientState(dt, comp._prevVoltage);
        } else if (comp instanceof Inductor) {
          comp.setTransientState(dt, comp._prevCurrent);
        }
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
        if (probe.type === 'voltage' && probe.component) {
          // Record voltage at component's pin 1 node (relative to ground)
          const nodeIdx = probeNodeIndices[i];
          probeValues[i].push(readMatrix.getNodeVoltage(solution, nodeIdx));
        } else if (probe.type === 'current' && probe.component) {
          const comp = probe.component;
          if (comp instanceof VoltageSource) {
            probeValues[i].push(readMatrix.getVSourceCurrent(solution, comp._vsIndex));
          } else {
            const v1 = readMatrix.getNodeVoltage(solution, comp._n1Index);
            const v2 = readMatrix.getNodeVoltage(solution, comp._n2Index);
            probeValues[i].push(this.computeCurrent(comp, v1 - v2, dt));
          }
        }
      }

      // Update state for next timestep
      for (const comp of components) {
        if (comp instanceof Capacitor) {
          const v1 = readMatrix.getNodeVoltage(solution, comp._n1Index);
          const v2 = readMatrix.getNodeVoltage(solution, comp._n2Index);
          comp._prevVoltage = v1 - v2;
        } else if (comp instanceof Inductor) {
          const v1 = readMatrix.getNodeVoltage(solution, comp._n1Index);
          const v2 = readMatrix.getNodeVoltage(solution, comp._n2Index);
          const g_eq = dt / comp.inductance;
          comp._prevCurrent = g_eq * (v1 - v2) + comp._prevCurrent;
        }
      }
    }

    // Reset components to DC mode
    for (const comp of components) {
      if (comp instanceof Capacitor) comp.resetToDC();
      else if (comp instanceof Inductor) comp.resetToDC();
      if (comp instanceof VoltageSource) {
        comp._effectiveVoltage = comp.declaredVoltage;
      }
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

  private computeCurrent(comp: TwoTerminalComponent, voltage: number, dt: number): number {
    if ('resistance' in comp) {
      return voltage / (comp as { resistance: number }).resistance;
    }
    if ('capacitance' in comp) {
      const cap = comp as Capacitor;
      return cap.capacitance * (voltage - cap._prevVoltage) / dt;
    }
    if ('inductance' in comp) {
      const ind = comp as Inductor;
      return ind._prevCurrent;
    }
    if ('computeDiodeCurrent' in comp) {
      return (comp as { computeDiodeCurrent(v: number): number }).computeDiodeCurrent(voltage);
    }
    return 0;
  }
}
