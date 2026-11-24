import type { Circuit } from '../core/Circuit';
import { SimulationSystem, TransientEngine } from './engine';
import { readProbe, type ProbeSpec } from './TransientAnalysis';

/**
 * Stepwise transient simulation. Unlike `TransientAnalysis.run()` which is
 * one-shot, this class keeps state between steps so the UI can drive a
 * continuous simulation (one or many steps per animation frame).
 *
 * The constructor solves the DC operating point (component readouts show it
 * for the first frame), then starts the transient from the zero state —
 * capacitors at 0 V, inductors at 0 A — like the batch analysis. Steps use
 * Backward Euler: the user can flip switches between steps, and BE never
 * rings on such discontinuities.
 */
export class TransientSession {
  private system: SimulationSystem;
  private engine: TransientEngine;
  private probeSpecs: ProbeSpec[];
  private finalized = false;

  public time = 0;
  public timePoints: number[] = [];
  public probeValues: number[][] = [];

  constructor(circuit: Circuit, probeSpecs: ProbeSpec[] = []) {
    this.probeSpecs = probeSpecs;
    this.system = new SimulationSystem(circuit);
    try {
      // DC operating point for the first frame.
      const op = this.system.operatingPoint();
      this.system.publish(op.x);
      this.engine = new TransientEngine(this.system, 'be', false, 'zero');
      this.engine.start('zero');
      // Keep the DC readouts on screen until the first step.
      this.system.publish(op.x);
    } catch (err) {
      this.system.release();
      throw err;
    }
    this.probeValues = probeSpecs.map(() => []);
  }

  /** Advance the simulation by one timestep dt. */
  step(dt: number): void {
    if (this.finalized) throw new Error('TransientSession.step() called after end()');
    // Switch/button states may have changed since the last step.
    this.engine.markDiscontinuity();
    this.engine.advance(dt, 'be');
    this.time = this.engine.time;
    const x = this.engine.x;

    this.timePoints.push(this.time);
    for (let i = 0; i < this.probeSpecs.length; i++) {
      this.probeValues[i].push(readProbe(this.probeSpecs[i], x, this.system.matrix));
    }
    // Update each component's voltage/current for live UI display
    this.system.publish(x);
  }

  /** Reset components to DC mode and clear node indices. Call once when stopping. */
  end(): void {
    if (this.finalized) return;
    this.finalized = true;
    for (const comp of this.system.components) comp.resetToDC();
    this.system.release();
  }
}
