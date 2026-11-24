/**
 * Generic behavioral-component hook.
 *
 * A `Behavioral` part is a component whose pins and model are supplied by
 * code outside the primitive library (e.g. a compiled VHDL process). Its
 * params stay plain JSON — `{ behavior, inputs, outputs, combPaths, config }`
 * — so a netlist containing behavioral parts still serializes and rebuilds
 * exactly; the `behavior` name selects a factory registered with
 * `registerBehavior`, which turns the JSON `config` into a `Model`.
 *
 *   registerBehavior('my-xor', (config, ctx) => ({
 *     reset() {},
 *     evaluate(h) {
 *       const a = h.read(ctx.inputs.a), b = h.read(ctx.inputs.b);
 *       h.out(ctx.outputs.y, (a > 1 || b > 1 ? 2 : a ^ b) | 8);
 *     },
 *   }));
 *   c.add('U1', new Behavioral({ behavior: 'my-xor', inputs: ['a', 'b'], outputs: ['y'],
 *                                combPaths: [['a', 'y', 0], ['b', 'y', 0]] }), { a: 'A', b: 'B', y: 'Y' });
 *
 * Driver kind: behavioral outputs are 'tristate' for lint purposes (they may
 * release to Z, like VHDL resolved signals), so several behavioral drivers on
 * one net are not F131; runtime contention is still D501. Default delay of
 * every output is 0 (inertial); models pass explicit per-transaction delays
 * through `Host.out(driver, drive, delayTicks)`.
 */
import type { Model, ModelCtx } from './model';
import type { JsonValue } from './parts';

/** Builds the model of one behavioral component from its JSON config. */
export type BehaviorFactory = (config: JsonValue, ctx: ModelCtx) => Model;

const REGISTRY = new Map<string, BehaviorFactory>();

export const BEHAVIOR_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Register (or replace) a behavior factory under a name. Registration is
 * explicit — call it before building a circuit that uses the behavior.
 */
export function registerBehavior(name: string, factory: BehaviorFactory): void {
  if (typeof name !== 'string' || !BEHAVIOR_NAME_RE.test(name)) {
    throw new Error(`registerBehavior: invalid behavior name ${JSON.stringify(name)} (letters, digits, '_' and '-', starting with a letter)`);
  }
  if (typeof factory !== 'function') throw new Error(`registerBehavior('${name}'): factory must be a function`);
  REGISTRY.set(name, factory);
}

export function hasBehavior(name: string): boolean {
  return REGISTRY.has(name);
}

export function behaviorFactory(name: string): BehaviorFactory {
  const f = REGISTRY.get(name);
  if (!f) {
    const known = [...REGISTRY.keys()].sort();
    throw new Error(
      `unknown behavior '${name}'${known.length ? ` (registered: ${known.join(', ')})` : ' (none registered)'}: register its factory with registerBehavior('${name}', factory) before building the circuit`,
    );
  }
  return f;
}
