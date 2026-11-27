/**
 * PCB panel of the viewer: the board of a circuit document drawn as SVG
 * (outline, holes, courtyards, pads by layer, silkscreen, reference
 * designators, ratsnest, and the suggested spot of unplaced parts as ghosts),
 * computed with the same layoutBoard() the CLI's pcb stage runs.
 */
import type { CircuitDoc } from '../doc/types';
import type { Diagnostic } from '../schema/types';
import { layoutBoard, type BoardLayout, type PlacedPad, type PlacedPart } from '../pcb/layout';
import { bbox } from '../pcb/geometry';
import { getFootprint } from '../pcb/footprints';

const esc = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = (v: number): string => String(Math.round(v * 1000) / 1000);
const pts = (poly: [number, number][]): string => poly.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');

export function boardOf(doc: CircuitDoc): BoardLayout | undefined {
  if (!doc.pcb) return undefined;
  return layoutBoard(doc.pcb, doc.components.map(c => ({ id: c.id, type: c.type, params: c.params, pins: c.pins })));
}

function padSvg(p: PlacedPad, cls: string): string {
  const t = `translate(${n(p.x)} ${n(p.y)}) rotate(${n(p.rot)})`;
  const w = p.w;
  const h = p.h;
  let shape: string;
  if (p.shape === 'circle') shape = `<circle class="cu" r="${n(Math.min(w, h) / 2)}"/>`;
  else {
    const r = p.shape === 'oval' ? Math.min(w, h) / 2 : p.shape === 'roundrect' ? Math.min(w, h) * 0.25 : 0;
    shape = `<rect class="cu" x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}"/>`;
  }
  const hole = p.drill !== undefined ? `<circle class="drill" r="${n(p.drill / 2)}"/>` : '';
  return `<g class="pad ${cls}" transform="${t}" data-net="${esc(p.net ?? '')}"><title>${esc(`${p.ref}${p.pin ? ` · pin ${p.pin}` : ''}${p.net ? ` · net ${p.net}` : ' · not connected'}`)}</title>${shape}${hole}</g>`;
}

function partSvg(p: PlacedPart, opts: { ghost?: boolean; error?: boolean }): string {
  const place = `translate(${n(p.x)} ${n(p.y)}) rotate(${n(p.rot)})${p.side === 'bottom' ? ' scale(-1 1)' : ''}`;
  const silk = (p.footprint.silk ?? [])
    .map(s => (s.kind === 'line' ? `<polyline points="${pts(s.points)}"/>` : `<circle cx="${n(s.x)}" cy="${n(s.y)}" r="${n(s.r)}"/>`))
    .join('');
  const court = p.courtyards.map(k => `<polygon class="court${opts.error ? ' bad' : ''}" points="${pts(k)}"/>`).join('');
  const pads = p.pads.map(pad => padSvg(pad, pad.layer === 'through' ? 'th' : pad.layer)).join('');
  const holes = p.holes.map(h => `<circle class="hole" cx="${n(h.x)}" cy="${n(h.y)}" r="${n(h.d / 2)}"/>`).join('');
  const cy = p.courtyards.flatMap(k => k);
  const b = bbox(cy);
  // Reference designator above the courtyard, unmirrored (the outer group flips y).
  const label = `<text class="ref" x="${n((b.minX + b.maxX) / 2)}" y="${n(-b.maxY - 0.6)}" transform="scale(1 -1)">${esc(p.id)}</text>`;
  return `<g class="part side-${p.side}${opts.ghost ? ' ghost' : ''}" data-id="${esc(p.id)}"><title>${esc(`${p.id} · ${p.footprint.name} · (${n(p.x)}, ${n(p.y)}) mm${p.rot ? ` · ${n(p.rot)}°` : ''}${p.side === 'bottom' ? ' · bottom' : ''}${opts.ghost ? ' · suggested spot (not placed)' : ''}`)}</title>${court}<g class="silk" transform="${place}">${silk}</g>${pads}${holes}${label}</g>`;
}

/** The board as an SVG string (y up: the content group is flipped). */
export function boardSvg(layout: BoardLayout, diagnostics: Diagnostic[] = []): string {
  const bad = new Set(diagnostics.filter(d => d.stage === 'pcb' && d.severity === 'error').flatMap(d => d.subject?.components ?? []));
  const b = bbox(layout.outline);
  const pad = 4;
  const vb = `${n(b.minX - pad)} ${n(-b.maxY - pad)} ${n(b.maxX - b.minX + 2 * pad)} ${n(b.maxY - b.minY + 2 * pad)}`;
  const holes = layout.board.holes.map(h => `<circle class="hole" cx="${n(h.x)}" cy="${n(h.y)}" r="${n(h.d / 2)}"><title>hole ⌀${n(h.d)} mm</title></circle>`).join('');
  const parts = layout.parts.map(p => partSvg(p, { error: bad.has(p.id) })).join('');
  const padAt = new Map<string, PlacedPad>();
  for (const p of layout.parts) for (const pad of p.pads) if (!padAt.has(pad.ref)) padAt.set(pad.ref, pad);
  const rats = layout.ratsnest
    .map(a => {
      const f = padAt.get(a.from);
      const t = padAt.get(a.to);
      return f && t ? `<line class="rat" x1="${n(f.x)}" y1="${n(f.y)}" x2="${n(t.x)}" y2="${n(t.y)}"><title>${esc(`${a.net}: ${a.from} → ${a.to} (${a.length} mm)`)}</title></line>` : '';
    })
    .join('');
  // Ghosts at the suggested free spot of every unplaced part.
  const ghosts = layout.unplaced
    .filter(u => u.suggested)
    .map(u => {
      const fp = getFootprint(u.footprint.name) ?? u.footprint;
      const s = u.suggested!;
      const a = (s.rot * Math.PI) / 180;
      const tr = (x: number, y: number): [number, number] => [s.x + x * Math.cos(a) - y * Math.sin(a), s.y + x * Math.sin(a) + y * Math.cos(a)];
      const ghost: PlacedPart = {
        id: u.id,
        type: '',
        footprint: fp,
        x: s.x,
        y: s.y,
        rot: s.rot,
        side: 'top',
        tech: fp.tech,
        courtyards: fp.courtyard.map(k => [tr(k.x - k.w / 2, k.y - k.h / 2), tr(k.x + k.w / 2, k.y - k.h / 2), tr(k.x + k.w / 2, k.y + k.h / 2), tr(k.x - k.w / 2, k.y + k.h / 2)]),
        pads: [],
        holes: [],
        pinPads: {},
        place: { x: s.x, y: s.y, rot: s.rot, side: 'top' },
      };
      return partSvg(ghost, { ghost: true });
    })
    .join('');
  return `<svg class="pcb-svg" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PCB">
<g transform="scale(1 -1)">
<polygon class="board" points="${pts(layout.outline)}"/>
${parts}${ghosts}${holes}${rats}
</g></svg>`;
}

/** Wheel zoom + drag pan on the SVG's viewBox; double-click resets. */
export function attachPanZoom(svg: SVGSVGElement): void {
  const initial = svg.getAttribute('viewBox')!;
  const vb = () => svg.getAttribute('viewBox')!.split(/\s+/).map(Number);
  svg.addEventListener(
    'wheel',
    e => {
      e.preventDefault();
      const [x, y, w, h] = vb();
      const r = svg.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const nw = w * k;
      const nh = h * k;
      svg.setAttribute('viewBox', `${x + (w - nw) * fx} ${y + (h - nh) * fy} ${nw} ${nh}`);
    },
    { passive: false },
  );
  let drag: { x: number; y: number; vb: number[] } | undefined;
  svg.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, vb: vb() };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const [x, y, w, h] = drag.vb;
    svg.setAttribute('viewBox', `${x - ((e.clientX - drag.x) * w) / r.width} ${y - ((e.clientY - drag.y) * h) / r.height} ${w} ${h}`);
  });
  svg.addEventListener('pointerup', () => (drag = undefined));
  svg.addEventListener('dblclick', () => svg.setAttribute('viewBox', initial));
}
