import { bench, defineComponent, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a custom load defined with only a DC stamp, used in an AC
 * analysis. The platform refuses to guess its small-signal behaviour.
 * Expected: S204 no-ac-model naming U1, exit 2. Fix: add ac(ctx) to the
 * defineComponent (here: ctx.stampConductance('a', 'b', ctx.params.g)).
 */
const Load = defineComponent({
  name: 'Load',
  pins: ['a', 'b'],
  params: { g: { default: 1e-3, unit: 'S' } },
  stamp(ctx) {
    ctx.stampConductance('a', 'b', ctx.params.g);
  },
});

export default bench('ac-no-model', (tb) => {
  const v1 = tb.add('V1', new VoltageSource({ dc: 0, ac: 1 }));
  const r1 = tb.add('R1', new Resistor('1k'));
  const u1 = tb.add('U1', new Load());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(u1.pin('a'));
  u1.pin('b').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', u1.pin('a'));

  tb.expect.ac({ from: '10', to: '10k' }).probe('out').gainAt('1k').toBeWithin(-6.1, -5.9);
});
