import type { Pin } from './Pin';

export class Node {
  readonly pins: Set<Pin> = new Set();
  index: number = -1;

  merge(other: Node): void {
    if (other === this) return;
    for (const pin of other.pins) {
      pin._node = this;
      this.pins.add(pin);
    }
    other.pins.clear();
  }
}
