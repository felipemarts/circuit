import { bench, defineComponent, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a custom "comparator" with no hysteresis and an ideal
 * (discontinuous) output. Before 1 ms it is idle and every point solves;
 * after 1 ms its output flips with the sign of its own input on every
 * Newton iteration, so no step size can make the iteration converge.
 * Expected: S202 naming U1 and the time (~1 ms), exit 2.
 */
const Chatter = defineComponent({
  name: 'Chatter',
  pins: ['in', 'gnd'],
  nonlinear: true,
  stamp(ctx) {
    if (ctx.mode !== 'tran' || ctx.time < 1e-3) return;
    const v = ctx.voltage('in') - ctx.voltage('gnd');
    ctx.stampCurrentSource('in', 'gnd', v > 0 ? -1e-3 : 1e-3);
  },
});

export default bench('nr-chatter-tran', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(0));
  const r1 = tb.add('R1', new Resistor('1k'));
  const u1 = tb.add('U1', new Chatter());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(u1.pin('in'));
  u1.pin('gnd').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('in', u1.pin('in'));

  tb.expect.tran({ tstop: '2m', dt: '10u' }).probe('in').toStayBelow(2);
});
