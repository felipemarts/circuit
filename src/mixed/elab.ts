/**
 * Mixed-signal elaboration: classify every net of a bench as analog or
 * pure-digital, plan the bridges at IC pins and at primitive pins that touch
 * analog nets, build the controller, run the bench-level digital lint
 * (F130–F134 from src/digital on the bench's digital netlist, F135–F138 here)
 * and resolve logic / IC-pin probes.
 */
import type { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { Node } from '../core/Node';
import type { Diagnostic } from '../schema/types';
import { lintDigital } from '../digital/lint';
import { partDef } from '../digital/parts';
import { LogicIC, LogicPrimitive, OutputStage } from './device';
import { FAMILY_REFERENCE_PART, logicFamilyModel, ne555Model } from './families';
import { MixedController, icPinNet, primitiveRamp, type IcEntry, type InputBridge, type MixedPlan, type OutputBridge } from './controller';
import { mixedDiagnostic } from './diagnostics';

export interface MixedElabInput {
  components: Map<string, Component>;
  netOf: (pin: Pin) => string;
  netPins: Map<string, Pin[]>;
  netNode: Map<string, Node>;
  locOf: Map<string, string | undefined>;
  /** Names given with tb.name. */
  userNets: Set<string>;
}

export interface MixedInfo {
  /** No analog component at all: the digital engine runs alone. */
  digitalOnly: boolean;
  controller: MixedController;
  /** Bench-level digital lint (F130–F138). */
  lint: Diagnostic[];
  /** Ids of logic primitives with no pin on an analog net (skipped by the analog lint). */
  digitalOnlyComps: Set<string>;
  /** Ids of ICs and logic primitives. */
  devices: Set<string>;
  /** Nets whose pins all belong to logic primitives. */
  pureNets: Set<string>;
  /** Logic probe → digital net, or undefined. */
  logicSignal(probe: string): string | undefined;
  /** Analog node of an IC / bridged primitive pin ref ('U1.1Y', 'U1.pin3', 'G1.y'). */
  pinNode(probe: string): Node | undefined;
  /** User-named nets with a logic meaning → digital net (captured in the RunRecord). */
  namedSignals: Map<string, string>;
}

const isIC = (c: Component): c is LogicIC => (c as { kind?: string }).kind === 'IC';
const isPrim = (c: Component): c is LogicPrimitive => (c as { kind?: string }).kind === 'LogicPrimitive';

/** Whether a component is a mixed-signal device (IC or logic primitive). */
export function isMixedDevice(c: Component): boolean {
  return isIC(c) || isPrim(c);
}

export function elaborateMixed(input: MixedElabInput): MixedInfo | undefined {
  const { components, netOf, netPins, locOf } = input;
  const ids = [...components.keys()].sort();
  const devices = new Set(ids.filter(id => isMixedDevice(components.get(id)!)));
  if (devices.size === 0) return undefined;

  // ── net classification ──
  const analogNets = new Set<string>(['gnd']);
  for (const [net, pins] of netPins) {
    if (pins.some(p => !isPrim(p.component))) analogNets.add(net);
  }
  const pureNets = new Set([...netPins.keys()].filter(n => !analogNets.has(n)));
  const digitalOnly = ids.every(id => isPrim(components.get(id)!));

  const display = new Map<string, string>();
  const inputs: InputBridge[] = [];
  const outputs: OutputBridge[] = [];
  const ics: IcEntry[] = [];
  const prims: MixedPlan['prims'] = [];
  const digitalOnlyComps = new Set<string>();
  const pinSignal = new Map<string, string>(); // 'U1.1Y' (canonical) → digital net
  const pinNodes = new Map<string, Pin>();

  for (const id of ids) {
    const c = components.get(id)!;
    if (isIC(c)) {
      const def = c.def;
      const vcc = c.pin(c.supplyName('vcc'));
      const gnd = c.pin(c.supplyName('gnd'));
      const fam = def.kind === 'logic' ? logicFamilyModel(def.id) : undefined;
      const timer = def.kind === 'timer' ? ne555Model() : undefined;
      const entry: IcEntry = { id, ic: c, vcc, gnd, fam, timer, stages: [], powered: true, everPowered: false, vs: 0 };
      c._stages.clear();
      for (const info of def.pins) {
        const pin = c.pin(info.number);
        const ref = `${id}.${info.name}`;
        pinNodes.set(ref, pin);
        if (info.role !== 'in' && info.role !== 'out') continue;
        const net = icPinNet(id, info.number);
        display.set(net, ref);
        pinSignal.set(ref, net);
        const supply = { kind: 'pins' as const, vcc, gnd };
        if (info.role === 'in') {
          inputs.push({
            owner: id,
            pin: info.name,
            display: ref,
            net,
            pinObj: pin,
            kind: info.bridge as InputBridge['kind'],
            supply,
            fam,
            timer,
            ...(timer ? { cont: c.pin('CONT') } : {}),
            checkZone: info.bridge === 'logic',
          });
        } else {
          const stage = new OutputStage();
          c._stages.set(info.name, stage);
          entry.stages.push(stage);
          outputs.push({
            owner: id,
            pin: info.name,
            display: ref,
            net,
            pinObj: pin,
            kind: info.bridge as OutputBridge['kind'],
            supply,
            stage,
            fam,
            timer,
            ramp: vs => def.ramp(vs),
          });
        }
      }
      ics.push(entry);
      for (const c2 of def.build({ vs: 5, corner: c.corner })) {
        display.set(`${id}__${c2.local}`, id);
        for (const target of Object.values(c2.pins)) if (target.startsWith('int:')) display.set(`_${id}__${target.slice(4)}`, `${id}:${target.slice(4)}`);
      }
      continue;
    }
    if (!isPrim(c)) continue;
    const layout = c.layout();
    const fam = logicFamilyModel(FAMILY_REFERENCE_PART[c.family]);
    const pins: Record<string, string> = {};
    c._bridged.clear();
    c._stages.clear();
    let anyAnalog = false;
    const driver = partDef(c.logicType).driver;
    const delay = c.params.delay;
    const d = typeof delay === 'number' ? delay : delay && typeof delay === 'object' && !Array.isArray(delay) ? Math.min(Number((delay as { rise: number }).rise), Number((delay as { fall: number }).fall)) : 0;
    for (const name of [...layout.inputs, ...layout.outputs]) {
      const pin = c.pin(name);
      const net = netOf(pin);
      const ref = `${id}.${name}`;
      if (!analogNets.has(net)) {
        pins[name] = net;
        pinSignal.set(ref, net);
        continue;
      }
      anyAnalog = true;
      if (c.logicType === 'Pull') {
        throw new Error(`Pull '${id}' is on an analog net (${net}): Pull is a digital-only weak driver — on analog nets use a Resistor to the supply or to tb.gnd`);
      }
      c._bridged.add(name);
      const dnet = `_${id}_${name}`;
      pins[name] = dnet;
      display.set(dnet, ref);
      pinSignal.set(ref, dnet);
      pinNodes.set(ref, pin);
      const supply = { kind: 'ideal' as const, vcc: c.vcc };
      if (layout.inputs.includes(name)) {
        inputs.push({ owner: id, pin: name, display: ref, net: dnet, pinObj: pin, kind: 'logic', supply, fam, checkZone: true });
      } else {
        const stage = new OutputStage();
        c._stages.set(name, stage);
        outputs.push({
          owner: id,
          pin: name,
          display: ref,
          net: dnet,
          pinObj: pin,
          kind: driver === 'tristate' ? 'tristate' : 'pushpull',
          supply,
          stage,
          fam,
          ramp: () => primitiveRamp(d),
        });
      }
    }
    if (!anyAnalog) digitalOnlyComps.add(id);
    prims.push({ id, prim: c, pins, at: locOf.get(id) });
  }
  for (const n of pureNets) display.set(n, n);
  for (const o of outputs) o.dangling = (netPins.get(netOf(o.pinObj)) ?? []).length <= 1;

  const plan: MixedPlan = { ics, prims, inputs, outputs, locOf, display };
  const controller = new MixedController(plan);

  // ── lint ──
  const lint: Diagnostic[] = [];
  const netsMembers = (net: string): Pin[] => netPins.get(net) ?? [];
  const pinRole = (p: Pin): 'in' | 'out' | 'tri' | 'oc' | 'supply' | 'analog' | 'other' => {
    const c = p.component;
    if (isIC(c)) {
      const info = c.pinInfo(p);
      if (info.role === 'vcc' || info.role === 'gnd') return 'supply';
      if (info.role === 'analog') return 'analog';
      if (info.role === 'in') return 'in';
      return info.bridge === 'tristate' ? 'tri' : info.bridge === 'disch555' ? 'oc' : 'out';
    }
    if (isPrim(c)) {
      const l = c.layout();
      if (l.inputs.includes(p.name)) return 'in';
      return partDef(c.logicType).driver === 'tristate' ? 'tri' : 'out';
    }
    return 'other';
  };
  const refOf = (p: Pin): string => {
    const c = p.component;
    const id = [...components.entries()].find(([, v]) => v === c)?.[0] ?? '?';
    return isIC(c) ? `${id}.${c.pinInfo(p).name}` : `${id}.${p.name}`;
  };
  const idOf = new Map<Component, string>([...components.entries()].map(([k, v]) => [v, k]));

  // F135 supply pins
  for (const e of ics) {
    const vNet = netOf(e.vcc);
    const gNet = netOf(e.gnd);
    const vName = e.ic.supplyName('vcc');
    const gName = e.ic.supplyName('gnd');
    const problems: string[] = [];
    if (netsMembers(vNet).length <= 1 && vNet !== 'gnd') problems.push(`${vName} (pin ${e.ic.pinInfo(e.vcc).number}) is not connected`);
    if (netsMembers(gNet).length <= 1 && gNet !== 'gnd') problems.push(`${gName} (pin ${e.ic.pinInfo(e.gnd).number}) is not connected`);
    if (vNet === gNet) problems.push(`${vName} and ${gName} are on the same net (${vNet})`);
    if (problems.length > 0) {
      lint.push(
        mixedDiagnostic('F135', 'lint', {
          message: `${e.id} (${e.ic.partId}): ${problems.join('; ')} — the IC has no supply`,
          subject: { components: [e.id], pins: [`${e.id}.${vName}`, `${e.id}.${gName}`] },
          note: 'a real IC is powered only through its supply pins: every logic level, output drive and threshold is referenced to VCC/GND',
          fixes: [{ kind: 'rewire', confidence: 'mechanical', detail: `connect ${e.id}.pin('${vName}') to the supply's + terminal and ${e.id}.pin('${gName}') to tb.gnd`, patch: `${e.id.toLowerCase()}.pin('${vName}').connect(v1.pin('+'));\n${e.id.toLowerCase()}.pin('${gName}').connect(tb.gnd);` }],
          at: locOf.get(e.id),
        }),
      );
    }
  }

  for (const net of [...analogNets].sort()) {
    const members = netsMembers(net);
    // F136 tied outputs
    const drivers = members.filter(p => ['out', 'tri'].includes(pinRole(p)));
    const pushpull = drivers.filter(p => pinRole(p) === 'out');
    if (pushpull.length >= 1 && drivers.length >= 2) {
      const refs = drivers.map(refOf).sort();
      lint.push(
        mixedDiagnostic('F136', 'lint', {
          message: `logic outputs ${refs.join(', ')} are tied together on net ${net}`,
          subject: { net, components: [...new Set(drivers.map(p => idOf.get(p.component)!))].sort(), pins: refs },
          note: 'a push-pull output always drives hard high or low; two of them on one wire short the supply through both output stages whenever they disagree (contention through the analog net)',
          fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `keep one driver on ${net}: combine the signals with a gate, or use tri-state outputs with mutually exclusive enables` }],
          at: locOf.get(idOf.get(drivers[0].component)!),
        }),
      );
    }
    // F138 output on a rail
    if (drivers.length > 0) {
      const railSource = members.some(p => (p.component as { kind?: string }).kind === 'VoltageSource');
      const icSupply = members.some(p => pinRole(p) === 'supply');
      if (net === 'gnd' || railSource || icSupply) {
        for (const p of drivers) {
          const ref = refOf(p);
          lint.push(
            mixedDiagnostic('F138', 'lint', {
              message: `logic output ${ref} is tied ${net === 'gnd' ? 'to ground' : railSource ? `to an ideal voltage source (net ${net})` : `to an IC supply rail (net ${net})`}`,
              subject: { net, components: [idOf.get(p.component)!], pins: [ref] },
              note: 'an output shorted to a rail fights it whenever it drives the other level: the current is limited only by the output resistance, far above the absolute maximum',
              fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `disconnect ${ref} from ${net}; to tie off an unused section, tie its INPUTS to a rail and leave the output open` }],
              at: locOf.get(idOf.get(p.component)!),
            }),
          );
        }
      }
    }
  }

  // F137 floating logic inputs (grouped per device)
  const floating = new Map<string, { errors: string[]; unused: string[] }>();
  for (const net of [...analogNets].sort()) {
    const members = netsMembers(net);
    const inputsHere = members.filter(p => pinRole(p) === 'in');
    if (inputsHere.length === 0 || net === 'gnd') continue;
    const defined = members.some(p => {
      const r = pinRole(p);
      if (r === 'out' || r === 'tri' || r === 'oc' || r === 'supply' || r === 'analog') return true;
      if (r !== 'other') return false;
      const kind = (p.component as { kind?: string }).kind ?? '';
      return kind !== 'Capacitor' && kind !== 'CurrentSource';
    });
    if (defined) continue;
    for (const p of inputsHere) {
      const id = idOf.get(p.component)!;
      const c = p.component;
      const entry = floating.get(id) ?? { errors: [], unused: [] };
      let unused = false;
      if (isIC(c) && members.length === 1) {
        const info = c.pinInfo(p);
        if (info.section > 0) {
          const sectionOuts = c.def.pins.filter(x => x.section === info.section && x.role === 'out');
          unused = sectionOuts.every(o => netsMembers(netOf(c.pin(o.number))).length <= 1);
        }
      }
      (unused ? entry.unused : entry.errors).push(refOf(p));
      floating.set(id, entry);
    }
  }
  for (const [id, { errors, unused }] of [...floating.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (errors.length > 0) {
      lint.push(
        mixedDiagnostic('F137', 'lint', {
          message: `logic input${errors.length > 1 ? 's' : ''} ${errors.sort().join(', ')} ${errors.length > 1 ? 'have' : 'has'} nothing that sets ${errors.length > 1 ? 'their' : 'its'} voltage (floating at the analog level)`,
          subject: { components: [id], pins: errors },
          note: 'a floating CMOS input drifts to an undefined level: the logic value is unknown and the input stage can oscillate or draw shoot-through current',
          fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `drive ${errors[0]} from an output, or tie it to a rail (directly, or through a pull-up/pull-down resistor)` }],
          at: locOf.get(id),
        }),
      );
    }
    if (unused.length > 0) {
      lint.push(
        mixedDiagnostic('F137', 'lint', {
          severity: 'warning',
          message: `unused section input${unused.length > 1 ? 's' : ''} ${unused.sort().join(', ')} left floating`,
          subject: { components: [id], pins: unused },
          note: 'the gate is unused (its output is open), but a floating CMOS input still wastes current and can oscillate; datasheets require tying unused inputs to GND or VCC. The simulator holds them low',
          fixes: [{ kind: 'rewire', confidence: 'mechanical', detail: `tie ${unused.join(', ')} to tb.gnd` }],
          at: locOf.get(id),
        }),
      );
    }
  }

  // Digital lint F130–F134 on the bench's digital netlist.
  {
    const nl = controller.netlist();
    for (const d of lintDigital({ components: nl.components, inputs: nl.inputs })) lint.push(controller.translate(d, 'lint'));
  }

  // ── probes ──
  const deviceOf = (probe: string): { id: string; rest: string; c: Component } | undefined => {
    const dot = probe.indexOf('.');
    if (dot <= 0) return undefined;
    const id = probe.slice(0, dot);
    const c = components.get(id);
    if (!c || !isMixedDevice(c)) return undefined;
    return { id, rest: probe.slice(dot + 1), c };
  };
  const canonicalRef = (probe: string): string | undefined => {
    const d = deviceOf(probe);
    if (!d) return undefined;
    try {
      const pin = d.c.pin(d.rest);
      return isIC(d.c) ? `${d.id}.${d.c.pinInfo(pin).name}` : `${d.id}.${pin.name}`;
    } catch {
      return undefined;
    }
  };
  const signalOfNet = (net: string): string | undefined => {
    if (pureNets.has(net)) return net;
    const members = netsMembers(net);
    const outs = members.filter(p => ['out', 'tri'].includes(pinRole(p))).map(refOf).sort();
    const ins = members.filter(p => pinRole(p) === 'in').map(refOf).sort();
    const ref = outs[0] ?? ins[0];
    return ref ? pinSignal.get(ref) : undefined;
  };
  const namedSignals = new Map<string, string>();
  for (const net of [...input.userNets].sort()) {
    const s = signalOfNet(net);
    if (s) namedSignals.set(net, s);
  }

  return {
    digitalOnly,
    controller,
    lint,
    digitalOnlyComps,
    devices,
    pureNets,
    namedSignals,
    logicSignal(probe: string): string | undefined {
      const ref = canonicalRef(probe);
      if (ref) return pinSignal.get(ref);
      if (input.userNets.has(probe) || pureNets.has(probe)) return signalOfNet(probe);
      return undefined;
    },
    pinNode(probe: string): Node | undefined {
      const ref = canonicalRef(probe);
      if (!ref) return undefined;
      const pin = pinNodes.get(ref);
      return pin ? pin.node : undefined;
    },
  };
}
