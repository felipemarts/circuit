import { bench, VoltageSource, NMOS, PMOS } from 'circuitsvibe';

/**
 * CMOS inverter from two generic Level-1 MOSFETs (free parameters, no
 * datasheet ratings): matched devices switch at VDD/2.
 */
export default bench('cmos-inverter', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource(0));
  const mn = tb.add('MN', new NMOS({ vto: 1, kp: '1m', lambda: 0.01 }));
  const mp = tb.add('MP', new PMOS({ vto: -1, kp: '1m', lambda: 0.01 }));

  vdd.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  mp.pin('s').connect(vdd.pin('+'));
  mp.pin('g').connect(vin.pin('+'));
  mn.pin('g').connect(vin.pin('+'));
  mn.pin('s').connect(tb.gnd);
  mp.pin('d').connect(mn.pin('d'));
  tb.name('out', mn.pin('d'));

  tb.expect.dc({ source: 'VIN', from: 0, to: 5, points: 101 })
    .probe('out')
    .toBeMonotonic('decreasing')
    .at(0).toBeAbove(4.99)
    .at(5).toBeBelow(0.01)
    .slopeAt(2.5).toBeBelow(-10)                   // gain > 10 at the switching point
    .toCross(2.5).between(2.4, 2.6);
});
