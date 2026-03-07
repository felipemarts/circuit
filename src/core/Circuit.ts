import { Pin } from './Pin';
import { Node } from './Node';
import { Component } from './Component';
import { DCAnalysis, type DCResult } from '../analysis/DCAnalysis';
import { TransientAnalysis, type TransientConfig, type TransientResult, type ProbeSpec } from '../analysis/TransientAnalysis';
import type { MNAMatrix } from '../solver/MNAMatrix';

class GroundComponent extends Component {
  constructor() {
    super();
    this.addPin('GND');
  }
  stamp(_matrix: MNAMatrix): void {}
}

export class Circuit {
  private readonly groundNode: Node;
  private readonly _groundPin: Pin;
  private readonly _groundComponent: GroundComponent;

  constructor() {
    this._groundComponent = new GroundComponent();
    this._groundPin = this._groundComponent.pin('GND');
    this.groundNode = this._groundPin.node;
    this.groundNode.index = 0;
  }

  get ground(): Pin {
    return this._groundPin;
  }

  analyze(type: 'dc'): DCResult;
  analyze(type: 'transient', config: TransientConfig, probes: ProbeSpec[]): TransientResult;
  analyze(type: string, config?: TransientConfig, probes?: ProbeSpec[]): DCResult | TransientResult {
    if (type === 'dc') {
      const analysis = new DCAnalysis();
      return analysis.run(this);
    }
    if (type === 'transient') {
      const analysis = new TransientAnalysis();
      return analysis.run(this, config!, probes ?? []);
    }
    throw new Error(`Unknown analysis type: ${type}`);
  }

  /**
   * Discover all components connected to the circuit via BFS from ground.
   * @internal
   */
  _discoverComponents(): { components: Component[]; nodes: Node[] } {
    const visitedNodes = new Set<Node>();
    const visitedComponents = new Set<Component>();
    // Use the pin's current node (may have been merged into a different Node object)
    const groundNode = this._groundPin.node;
    groundNode.index = 0;
    const queue: Node[] = [groundNode];
    visitedNodes.add(groundNode);

    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const pin of node.pins) {
        const comp = pin.component;
        if (visitedComponents.has(comp)) continue;
        visitedComponents.add(comp);

        for (const otherPin of comp.allPins()) {
          const otherNode = otherPin.node;
          if (!visitedNodes.has(otherNode)) {
            visitedNodes.add(otherNode);
            queue.push(otherNode);
          }
        }
      }
    }

    // Exclude the ground pseudo-component from results
    visitedComponents.delete(this._groundComponent);

    return {
      components: [...visitedComponents],
      nodes: [...visitedNodes],
    };
  }
}
