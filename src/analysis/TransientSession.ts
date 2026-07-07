import type { Circuit } from '../core/Circuit';
import type { Component } from '../core/Component';
import type { Node } from '../core/Node';
import { MNAMatrix } from '../solver/MNAMatrix';
import { NewtonRaphson } from '../solver/NewtonRaphson';
import type { ProbeSpec } from './TransientAnalysis';

/**
 * Stepwise transient simulation. Unlike `TransientAnalysis.run()` which is
 * one-shot, this class keeps state between steps so the UI can drive a
 * continuous simulation (one or many steps per animation frame).
 */
export class TransientSession {
  private circuit: Circuit;
  private components: Component[];
  private nodes: Node[];
  private nodeCount: number;
  private vsCount: number;
  private hasNonlinear: boolean;
  private probeSpecs: ProbeSpec[];
  private probeNodeIndices: number[];
  private finalized = false;

  public time = 0;
  public timePoints: number[] = [];
  public probeValues: number[][] = [];

  constructor(circuit: Circuit, probeSpecs: ProbeSpec[] = []) {
    this.circuit = circuit;
    this.probeSpecs = probeSpecs;

    const { components, nodes } = circuit._discoverComponents();
    if (components.length === 0) throw new Error('No components connected to ground');

    this.components = components;
    this.nodes = nodes;

    let nodeIndex = 1;
    for (const node of nodes) {
      if (node.index !== 0) node.index = nodeIndex++;
    }
    this.nodeCount = nodeIndex;

    // DC operating point
    let vsCount = 0;
    for (const comp of components) {
      const count = comp.getVSourceCount();
      if (count > 0) {
        comp.assignVSourceIndices(vsCount);
        vsCount += count;
      }
    }

    this.probeNodeIndices = probeSpecs.map(spec => {
      const n1 = spec.component ? (spec.component as { _n1Index?: number })._n1Index : undefined;
      if (typeof n1 === 'number') {
        return n1;
      }
      if (spec.component) {
        const pins = spec.component.allPins();
        if (pins.length > 0) return pins[0].node.index;
      }
      return 0;
    });

    this.hasNonlinear = components.some(c => c.isNonlinear());
    let dcSolution: number[];
    if (this.hasNonlinear) {
      dcSolution = NewtonRaphson.solve(this.nodeCount, vsCount, components);
    } else {
      const matrix = new MNAMatrix(this.nodeCount, vsCount);
      for (const comp of components) comp.stamp(matrix);
      dcSolution = matrix.solve();
    }

    // Update voltages/currents from DC for the first frame
    const readMatrix = new MNAMatrix(this.nodeCount, vsCount);
    for (const comp of components) {
      const r = comp.readResults(dcSolution, readMatrix);
      if (r) {
        comp._setResults(r.voltage, r.current);
      }
    }

    // Switch to transient mode
    for (const comp of components) comp.prepareTransientStep(0);

    let transientVsCount = 0;
    for (const comp of components) {
      const count = comp.getVSourceCount();
      if (count > 0) {
        comp.assignVSourceIndices(transientVsCount);
        transientVsCount += count;
      }
    }
    this.vsCount = transientVsCount;

    this.probeValues = probeSpecs.map(() => []);
  }

  /** Advance the simulation by one timestep dt. Returns the latest solution. */
  step(dt: number): void {
    this.time += dt;

    for (const comp of this.components) comp.setTime(this.time);
    for (const comp of this.components) comp.prepareTransientStep(dt);

    let solution: number[];
    if (this.hasNonlinear) {
      solution = NewtonRaphson.solve(this.nodeCount, this.vsCount, this.components);
    } else {
      const matrix = new MNAMatrix(this.nodeCount, this.vsCount);
      for (const comp of this.components) comp.stamp(matrix);
      solution = matrix.solve();
    }

    const readMatrix = new MNAMatrix(this.nodeCount, this.vsCount);

    // Probe values
    this.timePoints.push(this.time);
    for (let i = 0; i < this.probeSpecs.length; i++) {
      const probe = this.probeSpecs[i];
      if (probe.component) {
        const r = probe.component.readResults(solution, readMatrix);
        if (probe.type === 'voltage') {
          if (r) {
            this.probeValues[i].push(r.voltage);
          } else {
            this.probeValues[i].push(readMatrix.getNodeVoltage(solution, this.probeNodeIndices[i]));
          }
        } else {
          this.probeValues[i].push(r?.current ?? 0);
        }
      } else {
        this.probeValues[i].push(0);
      }
    }

    // Update each component's voltage/current for live UI display
    for (const comp of this.components) {
      const r = comp.readResults(solution, readMatrix);
      if (r) {
        comp._setResults(r.voltage, r.current);
      }
    }

    // Advance internal state for next step
    for (const comp of this.components) comp.updateState(solution, readMatrix);
  }

  /** Reset components to DC mode and clear node indices. Call once when stopping. */
  end(): void {
    if (this.finalized) return;
    this.finalized = true;
    for (const comp of this.components) comp.resetToDC();
    for (const node of this.nodes) {
      if (node.index !== 0) node.index = -1;
    }
  }
}
