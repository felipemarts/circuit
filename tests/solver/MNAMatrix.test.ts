import { describe, it, expect } from 'vitest';
import { MNAMatrix } from '../../src/solver/MNAMatrix';

describe('MNAMatrix', () => {
  it('stamps conductance correctly', () => {
    // 2 nodes (ground=0, node1=1), no voltage sources
    const m = new MNAMatrix(2, 0);
    m.stampConductance(1, 0, 0.001); // 1kΩ between node 1 and ground

    expect(m.G[0][0]).toBeCloseTo(0.001);
  });

  it('stamps conductance between two non-ground nodes', () => {
    // 3 nodes (ground=0, 1, 2)
    const m = new MNAMatrix(3, 0);
    m.stampConductance(1, 2, 0.5);

    expect(m.G[0][0]).toBeCloseTo(0.5);  // node1-node1
    expect(m.G[1][1]).toBeCloseTo(0.5);  // node2-node2
    expect(m.G[0][1]).toBeCloseTo(-0.5); // node1-node2
    expect(m.G[1][0]).toBeCloseTo(-0.5); // node2-node1
  });

  it('stamps voltage source correctly', () => {
    // 2 nodes + 1 voltage source
    const m = new MNAMatrix(2, 1);
    m.stampVoltageSource(1, 0, 0, 5); // 5V from node1 to ground

    const vsIdx = m.vsIndex(0); // should be 1
    expect(m.G[0][vsIdx]).toBe(1);  // node1 row, vs col
    expect(m.G[vsIdx][0]).toBe(1);  // vs row, node1 col
    expect(m.z[vsIdx]).toBe(5);     // RHS = 5V
  });

  it('stamps current source correctly', () => {
    const m = new MNAMatrix(2, 0);
    m.stampCurrentSource(1, 0, 0.01); // 10mA into node1

    expect(m.z[0]).toBeCloseTo(0.01);
  });

  it('clears matrix', () => {
    const m = new MNAMatrix(2, 0);
    m.stampConductance(1, 0, 0.001);
    m.clear();
    expect(m.G[0][0]).toBe(0);
    expect(m.z[0]).toBe(0);
  });
});
