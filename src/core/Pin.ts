import { Node } from './Node';
import type { Component } from './Component';

export class Pin {
  readonly component: Component;
  readonly name: string;
  /** @internal */
  _node: Node | null = null;

  constructor(component: Component, name: string) {
    this.component = component;
    this.name = name;
  }

  get node(): Node {
    if (!this._node) {
      this._node = new Node();
      this._node.pins.add(this);
    }
    return this._node;
  }

  connect(other: Pin): Pin {
    const thisNode = this.node;
    const otherNode = other.node;
    if (thisNode !== otherNode) {
      // Merge smaller into larger
      if (thisNode.pins.size >= otherNode.pins.size) {
        thisNode.merge(otherNode);
      } else {
        otherNode.merge(thisNode);
      }
    }
    return other;
  }
}
