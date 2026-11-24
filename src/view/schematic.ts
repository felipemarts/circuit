/**
 * SVG schematic renderer for the viewer: draws a Layout (symbols, wires,
 * ports, junctions, labels), pans/zooms (wheel, drag, touch pinch), and
 * animates EveryCircuit-style: wires and stubs take the net voltage color,
 * current flows as dots whose speed follows the current, LEDs glow with
 * their current, logic nets of pure-digital benches are colored by level.
 * Assertion chips and diagnostic highlights are anchored to parts and nets.
 */
import type { Layout, PlacedComponent, Point, Wire } from './layout';
import { G, esc } from './symbols';
import { voltageColor } from '../ui/voltageColor';
import type { LogicLevel } from '../schema/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface Chip {
  id: string;
  /** 'component' anchors at the part, 'net' at the net caption, 'pin' at a pin ('U1.1Y'). */
  anchor: { kind: 'component' | 'net' | 'pin'; id: string };
  verdict: 'pass' | 'fail';
  text: string;
  title?: string;
}

export interface Highlight {
  id: string;
  kind: 'error' | 'warning' | 'rating';
  badge?: string;
}

export interface FrameState {
  /** Net voltage (V). */
  netV: Map<string, number>;
  /** Current entering the component at each pin ref (A). */
  pinI: Map<string, number>;
  /** Full-scale voltage for the color map. */
  vmax: number;
  /** Full-scale current for dot speed / LED glow. */
  imax: number;
  /** Logic level per net (digital-only benches, or nets with a logic meaning). */
  logic?: Map<string, LogicLevel>;
}

interface DotTrack {
  el: SVGGElement;
  points: Point[];
  length: number;
  segLen: number[];
  /** Pin ref whose current drives this track (+ means current flows INTO that pin, i.e. towards points[0]). */
  ref?: string;
  sign: number;
  phase: number;
  dots: SVGCircleElement[];
}

const DOT_SPACING = 18;

export class Schematic {
  readonly svg: SVGSVGElement;
  private world: SVGGElement;
  private layout: Layout;
  private wireEls = new Map<string, SVGElement[]>(); // net → wires/stubs
  private tracks: DotTrack[] = [];
  private ledEls = new Map<string, SVGElement>();
  private compEls = new Map<string, SVGGElement>();
  private chipLayer: SVGGElement;
  private hlLayer: SVGGElement;
  private dotLayer: SVGGElement;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private pointers = new Map<number, Point>();
  private pinchStart: { dist: number; zoom: number; mid: Point } | null = null;
  private dragStart: { x: number; y: number; px: number; py: number } | null = null;
  private reducedMotion: boolean;
  private lastState: FrameState | null = null;
  private badgeBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  /** Drawing bounds including chips (chips may sit outside the layout box). */
  private bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  onChipClick: ((id: string) => void) | null = null;
  onComponentClick: ((id: string) => void) | null = null;

  constructor(layout: Layout, host: HTMLElement) {
    this.layout = layout;
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'schem');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('tabindex', '0');
    this.world = this.el('g', { class: 'world' });
    this.svg.appendChild(this.defs());
    this.svg.appendChild(this.world);
    this.hlLayer = this.el('g', { class: 'layer-hl' });
    this.world.appendChild(this.hlLayer);
    this.build();
    this.dotLayer = this.el('g', { class: 'layer-dots' });
    this.world.appendChild(this.dotLayer);
    this.chipLayer = this.el('g', { class: 'layer-chips' });
    this.world.appendChild(this.chipLayer);
    host.appendChild(this.svg);
    this.bindInteraction();
    this.fit();
  }

  private el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, html?: string): SVGElementTagNameMap[K] {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  private defs(): SVGDefsElement {
    const d = this.el('defs');
    d.innerHTML =
      `<filter id="led-blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="7"/></filter>` +
      `<filter id="dot-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    return d;
  }

  // ─── static drawing ───────────────────────────────────────────────────────

  private build(): void {
    const L = this.layout;
    const wires = this.el('g', { class: 'layer-wires' });
    const ports = this.el('g', { class: 'layer-ports' });
    const comps = this.el('g', { class: 'layer-comps' });
    const marks = this.el('g', { class: 'layer-marks' });
    this.world.append(wires, ports, comps, marks);

    const addWireEl = (net: string, e: SVGElement) => {
      const list = this.wireEls.get(net) ?? [];
      list.push(e);
      this.wireEls.set(net, list);
    };
    const pinByRef = new Map<string, { x: number; y: number; comp: PlacedComponent }>();
    for (const c of L.components) for (const p of c.pins) pinByRef.set(p.ref, { x: p.x, y: p.y, comp: c });
    const pinAt = (pt: Point, exclude: string): string | undefined => {
      for (const c of L.components) for (const p of c.pins) if (p.ref !== exclude && p.x === pt.x && p.y === pt.y) return p.ref;
      return undefined;
    };

    for (const w of L.wires) {
      if (w.points.length < 2) continue;
      const pl = this.el('polyline', { class: 'wire', points: w.points.map(p => `${p.x},${p.y}`).join(' '), 'data-net': w.net });
      pl.appendChild(this.el('title', {}, esc(w.net)));
      wires.appendChild(pl);
      addWireEl(w.net, pl);
      // Current for the dots: the start pin's current, else the pin at the far end.
      let ref: string | undefined = w.from;
      let sign = 1;
      const far = pinAt(w.points[w.points.length - 1], w.from);
      this.tracks.push(this.track(w.points, ref, sign, far));
    }
    for (const port of L.ports) {
      const g = this.el('g', { class: `port port-${port.kind}`, 'data-net': port.net });
      for (const seg of port.points) {
        const pl = this.el('polyline', { class: 'wire', points: seg.map(p => `${p.x},${p.y}`).join(' '), 'data-net': port.net });
        g.appendChild(pl);
        addWireEl(port.net, pl);
        const ref = port.pinRefs.find(r => {
          const pp = pinByRef.get(r);
          return pp && pp.x === seg[0].x && pp.y === seg[0].y;
        });
        if (ref) this.tracks.push(this.track(seg, ref, 1));
      }
      const y = port.y;
      if (port.kind === 'gnd') {
        const s = port.dirY > 0 ? 1 : -1;
        g.appendChild(this.el('path', { class: 'sym port-sym', d: `M${port.x - 12} ${y}h24M${port.x - 8} ${y + 5 * s}h16M${port.x - 4} ${y + 10 * s}h8` }));
      } else {
        const s = port.dirY;
        g.appendChild(this.el('path', { class: 'sym port-sym rail-sym', d: `M${port.x - 10} ${y}h20` }));
        const t = this.el('text', { class: 'rail-txt', x: port.x, y: s < 0 ? y - 5 : y + 13, 'text-anchor': 'middle' }, esc(port.label ?? port.net));
        g.appendChild(t);
      }
      ports.appendChild(g);
    }

    for (const c of L.components) {
      const g = this.el('g', { class: `comp comp-${c.sym.kind} type-${c.type.replace(/[^A-Za-z0-9_-]/g, '_')}`, 'data-id': c.id, tabindex: '0', role: 'group' });
      g.appendChild(this.el('title', {}, `${esc(c.id)} · ${esc(c.type)}${c.sym.value ? ` · ${esc(c.sym.value)}` : ''}`));
      // Pin stubs (take the net color).
      for (const p of c.pins) {
        const st = this.el('line', { class: 'stub', x1: p.x, y1: p.y, x2: p.bx, y2: p.by, 'data-net': p.net });
        g.appendChild(st);
        addWireEl(p.net, st);
        this.tracks.push(this.track([{ x: p.x, y: p.y }, { x: p.bx, y: p.by }], p.ref, 1));
      }
      const body = this.el('g', { class: 'body', transform: `translate(${c.x} ${c.y}) rotate(${c.rotation})` });
      body.innerHTML = c.sym.svg;
      g.appendChild(body);
      if (c.type === 'LED') {
        const glow = body.querySelector('.led-glow');
        if (glow) this.ledEls.set(c.id, glow as SVGElement);
      }
      // Labels: never rotated.
      const vertical = c.rotation === 90 || c.rotation === 270;
      const isBoxy = c.sym.kind === 'ic' || c.sym.kind === 'box' || c.sym.kind === 'gate' || c.sym.kind === 'opamp';
      if (isBoxy) {
        g.appendChild(this.el('text', { class: 'lbl lbl-id', x: c.x - c.hw + 2, y: c.y - c.hh - 4 }, esc(c.sym.label)));
        if (c.sym.value) g.appendChild(this.el('text', { class: 'lbl lbl-val', x: c.x + c.hw - 2, y: c.y - c.hh - 4, 'text-anchor': 'end' }, esc(c.sym.value)));
      } else if (c.sym.kind === 'transistor' || c.sym.kind === 'source' || vertical || c.sym.kind === 'switch') {
        const lx = c.x + c.hw + 5;
        g.appendChild(this.el('text', { class: 'lbl lbl-id', x: lx, y: c.y - 2 }, esc(c.sym.label)));
        if (c.sym.value) g.appendChild(this.el('text', { class: 'lbl lbl-val', x: lx, y: c.y + 11 }, esc(c.sym.value)));
      } else {
        g.appendChild(this.el('text', { class: 'lbl lbl-id', x: c.x, y: c.y - c.hh - 5, 'text-anchor': 'middle' }, esc(c.sym.label)));
        if (c.sym.value) g.appendChild(this.el('text', { class: 'lbl lbl-val', x: c.x, y: c.y + c.hh + 13, 'text-anchor': 'middle' }, esc(c.sym.value)));
      }
      comps.appendChild(g);
      this.compEls.set(c.id, g);
      g.addEventListener('click', () => this.onComponentClick?.(c.id));
      g.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onComponentClick?.(c.id);
        }
      });
    }

    for (const j of L.junctions) {
      const dot = this.el('circle', { class: 'junction', cx: j.x, cy: j.y, r: 3.2, 'data-net': j.net });
      marks.appendChild(dot);
      addWireEl(j.net, dot);
    }
    for (const nc of L.noConnects) {
      marks.appendChild(this.el('path', { class: 'nc', d: `M${nc.x - 3} ${nc.y - 3}l6 6M${nc.x - 3} ${nc.y + 3}l6 -6` }));
    }
    for (const lb of L.labels) {
      if (lb.kind === 'caption') {
        marks.appendChild(this.el('text', { class: 'net-caption', x: lb.x, y: lb.y, 'text-anchor': 'middle', 'data-net': lb.net }, esc(lb.net)));
      } else {
        const d = lb.dir ?? 'r';
        const dx = d === 'l' ? -1 : d === 'r' ? 1 : 0;
        const dy = d === 't' ? -1 : d === 'b' ? 1 : 0;
        const w = lb.net.length * 6.4 + 14;
        const g = this.el('g', { class: 'net-flag', 'data-net': lb.net });
        // stub from the pin exit to the flag, then a flag pointing along the exit direction
        const x1 = lb.x + dx * G;
        const y1 = lb.y + dy * G;
        g.appendChild(this.el('line', { class: 'wire', x1: lb.x, y1: lb.y, x2: x1, y2: y1, 'data-net': lb.net }));
        if (dx !== 0) {
          const bx = dx > 0 ? x1 : x1 - w;
          g.appendChild(this.el('path', { class: 'flag-body', d: dx > 0 ? `M${x1} ${y1}l6 -8h${w - 6}v16h-${w - 6}z` : `M${x1} ${y1}l-6 -8h-${w - 6}v16h${w - 6}z` }));
          g.appendChild(this.el('text', { class: 'flag-txt', x: bx + (dx > 0 ? 9 : 5), y: y1 + 3.5 }, esc(lb.net)));
        } else {
          g.appendChild(this.el('path', { class: 'flag-body', d: dy > 0 ? `M${x1} ${y1}l-8 6v12h16v-12z` : `M${x1} ${y1}l-8 -6v-12h16v12z` }));
          g.appendChild(this.el('text', { class: 'flag-txt', x: x1, y: dy > 0 ? y1 + 15 : y1 - 9, 'text-anchor': 'middle' }, esc(lb.net)));
        }
        marks.appendChild(g);
        const list = this.wireEls.get(lb.net) ?? [];
        list.push(g.firstElementChild as SVGElement);
        this.wireEls.set(lb.net, list);
      }
    }
  }

  private track(points: Point[], ref: string | undefined, sign: number, farRef?: string): DotTrack {
    const g = this.el('g', { class: 'track' });
    this.dotLayer?.appendChild(g);
    const segLen: number[] = [];
    let length = 0;
    for (let k = 1; k < points.length; k++) {
      const l = Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
      segLen.push(l);
      length += l;
    }
    const t: DotTrack = { el: g, points, length, segLen, ref, sign, phase: 0, dots: [] };
    (t as DotTrack & { farRef?: string }).farRef = farRef;
    return t;
  }

  private pointAt(t: DotTrack, dist: number): Point {
    let d = dist;
    for (let k = 0; k < t.segLen.length; k++) {
      if (d <= t.segLen[k] || k === t.segLen.length - 1) {
        const a = t.points[k];
        const b = t.points[k + 1];
        const f = t.segLen[k] === 0 ? 0 : Math.min(1, d / t.segLen[k]);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      d -= t.segLen[k];
    }
    return t.points[0];
  }

  // ─── dynamic state ────────────────────────────────────────────────────────

  /** Apply voltages / currents / logic levels for one frame. */
  setState(s: FrameState): void {
    this.lastState = s;
    for (const [net, els] of this.wireEls) {
      let color: string | undefined;
      const lv = s.logic?.get(net);
      if (lv !== undefined && !s.netV.has(net)) {
        color = lv === 1 ? 'var(--logic-1)' : lv === 0 ? 'var(--logic-0)' : lv === 'Z' ? 'var(--logic-z)' : 'var(--logic-x)';
      } else {
        const v = net === 'gnd' ? 0 : s.netV.get(net);
        if (v !== undefined) color = voltageColor(v, s.vmax);
      }
      for (const e of els) {
        if (color) {
          e.style.stroke = color;
          if (e.classList.contains('junction')) e.style.fill = color;
        } else {
          e.style.stroke = '';
          e.style.fill = '';
        }
      }
    }
    for (const [id, glow] of this.ledEls) {
      const comp = this.layout.components.find(c => c.id === id)!;
      const anode = comp.pins.find(p => p.name === 'anode')!;
      const i = s.pinI.get(anode.ref) ?? 0;
      const ref = Math.max(2e-3, Math.min(20e-3, s.imax));
      const k = Math.max(0, Math.min(1, i / ref));
      glow.style.opacity = String(k * 0.85);
      glow.style.fill = 'var(--led)';
    }
    if (this.reducedMotion) this.tick(0);
  }

  /** Advance the current dots by dt seconds (speed in simulated-display units). */
  tick(dt: number): void {
    const s = this.lastState;
    if (!s) return;
    const iRef = Math.max(s.imax, 1e-9);
    for (const t of this.tracks) {
      let i: number | undefined;
      if (t.ref) i = s.pinI.get(t.ref);
      let sign = t.sign;
      const far = (t as DotTrack & { farRef?: string }).farRef;
      if (i === undefined && far) {
        i = s.pinI.get(far);
        sign = -sign;
      }
      const mag = Math.abs(i ?? 0);
      const want = i !== undefined && mag > iRef * 2e-3 && t.length >= 6 ? Math.max(1, Math.floor(t.length / DOT_SPACING)) : 0;
      while (t.dots.length < want) {
        const c = this.el('circle', { class: 'dot', r: 2.6 });
        t.el.appendChild(c);
        t.dots.push(c);
      }
      while (t.dots.length > want) t.dots.pop()!.remove();
      if (want === 0) continue;
      // Positive current INTO the pin means charge moves along the track towards points[0].
      const dir = (i! > 0 ? -1 : 1) * sign;
      const speed = (24 + 110 * Math.sqrt(Math.min(1, mag / iRef))) * dt;
      t.phase = (((t.phase + dir * speed) % DOT_SPACING) + DOT_SPACING) % DOT_SPACING;
      const spacing = t.length / want;
      for (let k = 0; k < want; k++) {
        const d = (t.phase + k * spacing) % t.length;
        const p = this.pointAt(t, d);
        t.dots[k].setAttribute('cx', String(p.x));
        t.dots[k].setAttribute('cy', String(p.y));
      }
    }
  }

  /**
   * Assertion chips anchored on the drawing. Each chip tries a ring of
   * candidate spots around its anchor (above, right, below, left, then
   * farther out) and takes the first that overlaps no part, label or chip.
   */
  setChips(chips: Chip[]): void {
    this.chipLayer.innerHTML = '';
    const captionOf = new Map(this.layout.labels.filter(l => l.kind === 'caption').map(l => [l.net, l]));
    interface Box {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
    const obstacles: Box[] = [];
    for (const c of this.layout.components) {
      // body + label block (labels to the right of vertical parts / transistors / sources, above+below otherwise)
      const vertical = c.rotation === 90 || c.rotation === 270;
      const rightLabelled = c.sym.kind === 'transistor' || c.sym.kind === 'source' || c.sym.kind === 'switch' || vertical;
      const chars = Math.max(c.sym.label.length, (c.sym.value ?? '').length);
      if (rightLabelled) obstacles.push({ x0: c.x - c.hw - 2, y0: c.y - c.hh - 2, x1: c.x + c.hw + 8 + chars * 6.4, y1: c.y + c.hh + 2 });
      else obstacles.push({ x0: c.x - Math.max(c.hw, (chars * 6.4) / 2) - 2, y0: c.y - c.hh - 16, x1: c.x + Math.max(c.hw, (chars * 6.4) / 2) + 2, y1: c.y + c.hh + 16 });
    }
    for (const p of this.layout.ports) obstacles.push({ x0: p.x - 14, y0: p.y - 14, x1: p.x + 14, y1: p.y + 14 });
    obstacles.push(...this.badgeBoxes);
    // Wires as thin boxes: a chip over a wire hides a junction or a corner.
    for (const w of [...this.layout.wires, ...this.layout.ports.flatMap(p => p.points.map(points => ({ points })))]) {
      for (let k = 1; k < w.points.length; k++) {
        const a = w.points[k - 1];
        const b = w.points[k];
        obstacles.push({ x0: Math.min(a.x, b.x) - 3, y0: Math.min(a.y, b.y) - 3, x1: Math.max(a.x, b.x) + 3, y1: Math.max(a.y, b.y) + 3 });
      }
    }
    for (const l of this.layout.labels) obstacles.push({ x0: l.x - l.net.length * 3.2 - 4, y0: l.y - 12, x1: l.x + l.net.length * 3.2 + 4, y1: l.y + 4 });
    const hits = (b: Box): boolean => obstacles.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    // Chips may extend past the layout box by one chip height; fit() includes them.
    const inside = (b: Box): boolean => b.x0 >= -40 && b.y0 >= -24 && b.x1 <= this.layout.width + 40 && b.y1 <= this.layout.height + 24;
    this.bounds = { x0: 0, y0: 0, x1: this.layout.width, y1: this.layout.height };

    for (const chip of chips) {
      const w = chip.text.length * 6.1 + 24;
      const hgt = 18;
      let ax: number;
      let ay: number;
      let ahw: number;
      let ahh: number;
      if (chip.anchor.kind === 'component') {
        const c = this.layout.components.find(cc => cc.id === chip.anchor.id);
        if (!c) continue;
        ax = c.x;
        ay = c.y;
        ahw = c.hw;
        ahh = c.hh;
      } else if (chip.anchor.kind === 'pin') {
        const pin = this.layout.components.flatMap(c => c.pins).find(p => p.ref === chip.anchor.id);
        if (!pin) continue;
        const d = pin.dir === 'l' ? [-1, 0] : pin.dir === 'r' ? [1, 0] : pin.dir === 't' ? [0, -1] : [0, 1];
        ax = pin.x + d[0] * 2 * G;
        ay = pin.y + d[1] * 2 * G;
        ahw = 4;
        ahh = 4;
      } else {
        const cap = captionOf.get(chip.anchor.id);
        const pin = this.layout.components.flatMap(c => c.pins).find(p => p.net === chip.anchor.id);
        if (!cap && !pin) continue;
        ax = cap ? cap.x : pin!.x;
        ay = cap ? cap.y - 4 : pin!.y;
        ahw = cap ? chip.anchor.id.length * 3.2 : 4;
        ahh = cap ? 6 : 4;
      }
      // Candidate centres, nearest first.
      const cands: { x: number; y: number }[] = [];
      for (let ring = 0; ring < 6; ring++) {
        const d = 8 + ring * 20;
        cands.push({ x: ax, y: ay - ahh - d - hgt / 2 }); // above
        cands.push({ x: ax + ahw + d + w / 2, y: ay - ring * 6 }); // right
        cands.push({ x: ax, y: ay + ahh + d + hgt / 2 }); // below
        cands.push({ x: ax - ahw - d - w / 2, y: ay + ring * 6 }); // left
        cands.push({ x: ax + ahw + d + w / 2, y: ay - ahh - 10 }); // upper right
        cands.push({ x: ax - ahw - d - w / 2, y: ay - ahh - 10 }); // upper left
      }
      let spot = cands[0];
      for (const c of cands) {
        const b: Box = { x0: c.x - w / 2, y0: c.y - hgt / 2, x1: c.x + w / 2, y1: c.y + hgt / 2 };
        if (!hits(b) && inside(b)) {
          spot = c;
          break;
        }
      }
      const x = spot.x;
      const y = spot.y;
      obstacles.push({ x0: x - w / 2 - 2, y0: y - hgt / 2 - 2, x1: x + w / 2 + 2, y1: y + hgt / 2 + 2 });
      this.bounds.x0 = Math.min(this.bounds.x0, x - w / 2 - 8);
      this.bounds.y0 = Math.min(this.bounds.y0, y - hgt / 2 - 8);
      this.bounds.x1 = Math.max(this.bounds.x1, x + w / 2 + 8);
      this.bounds.y1 = Math.max(this.bounds.y1, y + hgt / 2 + 8);
      const g = this.el('g', { class: `chip chip-${chip.verdict}`, 'data-assertion': chip.id, tabindex: '0', role: 'button', transform: `translate(${x - w / 2} ${y - 9})` });
      g.appendChild(this.el('title', {}, esc(chip.title ?? chip.text)));
      g.appendChild(this.el('rect', { width: w, height: 18, rx: 9 }));
      g.appendChild(this.el('text', { class: 'chip-mark', x: 9, y: 13 }, chip.verdict === 'pass' ? '✓' : '✗'));
      g.appendChild(this.el('text', { class: 'chip-txt', x: 20, y: 13 }, esc(chip.text)));
      g.addEventListener('click', e => {
        e.stopPropagation();
        this.onChipClick?.(chip.id);
      });
      g.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.onChipClick?.(chip.id);
        }
      });
      this.chipLayer.appendChild(g);
    }
    this.fit();
  }

  /** Culprit / rating-violation highlights. */
  setHighlights(hl: Highlight[]): void {
    this.hlLayer.innerHTML = '';
    this.badgeBoxes = [];
    for (const c of this.layout.components) c.sym && this.compEls.get(c.id)?.classList.remove('hl-error', 'hl-warning', 'hl-rating');
    for (const h of hl) {
      const c = this.layout.components.find(cc => cc.id === h.id);
      if (!c) continue;
      this.compEls.get(c.id)?.classList.add(`hl-${h.kind}`);
      const pad = 8;
      this.hlLayer.appendChild(this.el('rect', { class: `hl hl-${h.kind}`, x: c.x - c.hw - pad, y: c.y - c.hh - pad, width: 2 * c.hw + 2 * pad, height: 2 * c.hh + 2 * pad, rx: 8 }));
      if (h.badge) {
        const bw = h.badge.length * 6.4 + 10;
        const bx = c.x + c.hw + pad - bw / 2;
        const by = c.y - c.hh - pad - 8;
        this.badgeBoxes.push({ x0: bx - 4, y0: by - 4, x1: bx + bw + 4, y1: by + 20 });
        const g = this.el('g', { class: `hl-badge hl-${h.kind}`, transform: `translate(${bx} ${by})` });
        g.appendChild(this.el('rect', { width: bw, height: 16, rx: 4 }));
        g.appendChild(this.el('text', { x: bw / 2, y: 11.5, 'text-anchor': 'middle' }, esc(h.badge)));
        this.hlLayer.appendChild(g);
      }
    }
  }

  /** Flash a component (e.g. when its assertion row is hovered). */
  focusComponent(id: string | null): void {
    for (const [cid, g] of this.compEls) g.classList.toggle('focus', cid === id);
  }

  // ─── view transform ───────────────────────────────────────────────────────

  private applyTransform(): void {
    this.world.setAttribute('transform', `translate(${this.panX} ${this.panY}) scale(${this.zoom})`);
  }

  /** Fit the drawing into the host with padding. */
  fit(): void {
    const r = this.svg.getBoundingClientRect();
    const W = r.width || 800;
    const H = r.height || 500;
    const pad = 28;
    const b = this.bounds.x1 > 0 ? this.bounds : { x0: 0, y0: 0, x1: this.layout.width, y1: this.layout.height };
    const bw = b.x1 - b.x0;
    const bh = b.y1 - b.y0;
    const z = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh, 1.6);
    this.zoom = Math.max(0.2, z);
    this.panX = (W - bw * this.zoom) / 2 - b.x0 * this.zoom;
    this.panY = (H - bh * this.zoom) / 2 - b.y0 * this.zoom;
    this.applyTransform();
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const r = this.svg.getBoundingClientRect();
    const x = cx ?? r.width / 2;
    const y = cy ?? r.height / 2;
    const z = Math.max(0.15, Math.min(6, this.zoom * factor));
    this.panX = x - ((x - this.panX) * z) / this.zoom;
    this.panY = y - ((y - this.panY) * z) / this.zoom;
    this.zoom = z;
    this.applyTransform();
  }

  private bindInteraction(): void {
    const svg = this.svg;
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('.chip')) return;
      svg.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) this.dragStart = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
      else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        this.dragStart = null;
      }
    });
    svg.addEventListener('pointermove', e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2 && this.pinchStart) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const r = svg.getBoundingClientRect();
        const factor = (dist / this.pinchStart.dist) * (this.pinchStart.zoom / this.zoom);
        this.zoomBy(factor, this.pinchStart.mid.x - r.left, this.pinchStart.mid.y - r.top);
      } else if (this.dragStart) {
        this.panX = this.dragStart.px + (e.clientX - this.dragStart.x);
        this.panY = this.dragStart.py + (e.clientY - this.dragStart.y);
        this.applyTransform();
        svg.classList.add('dragging');
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStart = null;
      if (this.pointers.size === 0) {
        this.dragStart = null;
        svg.classList.remove('dragging');
      }
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('dblclick', () => this.fit());
    svg.addEventListener('keydown', e => {
      const step = 40;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.2);
      else if (e.key === '-') this.zoomBy(1 / 1.2);
      else if (e.key === '0') this.fit();
      else if (e.key === 'ArrowLeft') this.panX += step;
      else if (e.key === 'ArrowRight') this.panX -= step;
      else if (e.key === 'ArrowUp') this.panY += step;
      else if (e.key === 'ArrowDown') this.panY -= step;
      else return;
      e.preventDefault();
      this.applyTransform();
    });
  }

  /** Export the current drawing as a standalone SVG string (theme colors inlined). */
  toSvgString(): string {
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('viewBox', `0 0 ${this.layout.width} ${this.layout.height}`);
    clone.setAttribute('width', String(this.layout.width));
    clone.setAttribute('height', String(this.layout.height));
    clone.querySelector('.world')?.setAttribute('transform', '');
    return new XMLSerializer().serializeToString(clone);
  }
}

export type { Wire };
