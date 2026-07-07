import { Pin } from './Pin';
import type { MNAMatrix } from '../solver/MNAMatrix';

export abstract class Component {
  protected readonly pins: Map<string, Pin> = new Map();

  protected addPin(name: string): Pin {
    const pin = new Pin(this, name);
    this.pins.set(name, pin);
    return pin;
  }

  pin(name: string | number): Pin {
    const key = String(name);
    const p = this.pins.get(key);
    if (!p) {
      throw new Error(`Component has no pin "${key}". Available: ${[...this.pins.keys()].join(', ')}`);
    }
    return p;
  }

  allPins(): Pin[] {
    return [...this.pins.values()];
  }

  /**
   * All (name, pin) entries in registration order, including aliases
   * ('+'/'-', 'anode'/'cathode') that point at the same Pin object.
   */
  pinEntries(): [string, Pin][] {
    return [...this.pins.entries()];
  }

  abstract stamp(matrix: MNAMatrix): void;

  isNonlinear(): boolean {
    return false;
  }

  // --- Protocol methods for generic analysis engine support ---

  getVSourceCount(): number { return 0; }

  assignVSourceIndices(_startIndex: number): void {}

  prepareTransientStep(_dt: number): void {}

  updateState(_solution: number[], _matrix: MNAMatrix): void {}

  setTime(_t: number): void {}

  resetToDC(): void {}

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } | null { return null; }

  /** @internal Called by the solver after analysis with the readResults values */
  _setResults(_voltage: number, _current: number): void {}

  setOperatingPoint(_solution: number[], _matrix: MNAMatrix): void {}

  getOperatingVoltage(): number { return 0; }
}
