/**
 * Share-link viewer: `app.html#c=1.<payload>` → decode → auto-layout →
 * simulate in a worker → verdict / assertions / diagnostics / ratings /
 * scope / Bode / DC / logic / serial / sources panels + live animation on
 * the schematic.
 */
import './viewer.css';
import { decodeShareUrl } from '../doc/share';
import { canonicalJson } from '../doc/canonical';
import { isCircuitDocError } from '../doc/errors';
import type { CircuitDoc } from '../doc/types';
import type { Diagnostic, LogicLevel } from '../schema/types';
import { layoutCircuit, type Layout } from './layout';
import { Schematic, type FrameState } from './schematic';
import { runSimulation } from './run';
import type { SimProgress, SimResult } from './simulate';
import {
  animationScales,
  assertionModels,
  bodeModel,
  dcModel,
  diagnosticModels,
  highlightModels,
  indexAt,
  logicAt,
  logicModel,
  ratingGroups,
  scopeModel,
  serialModels,
  sourceLocation,
  sourceModels,
  verdictModel,
  type AssertionModel,
  type BodeCurve,
  type DcCurveModel,
  type DiagnosticModel,
  type LogicModel,
  type RatingGroup,
  type ScopeModel,
  type SerialModel,
  type SourceLocation,
  type SourceMark,
  type SourceModel,
  type VerdictModel,
} from './models';
import { highlightLines } from './highlight';
import { bodeHeight, dcHeight, drawBode, drawDc, drawLogic, drawScope, logicHeight, scopeHeight } from './plots';
import { eng, secs, valueLabel } from './format';
import { voltageGradientCSS, setVoltageZeroColor } from '../ui/voltageColor';
import { t, isPT } from './i18n';
import { esc } from './symbols';

const BRAND_SVG = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#0b1120"/><path d="M9 36h10l5-17 8 30 8-30 5 17h9" fill="none" stroke="url(#cvg)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="55" cy="36" r="4.5" fill="#fbbf24"/></svg>`;
const ICON = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v12M6 11l6 6 6-6M4 20h16"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13 7l4 4"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  moon: '<svg class="moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  sun: '<svg class="sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  github: '<svg viewBox="0 0 16 16" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
};

const h = (html: string): HTMLElement => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
};
const $ = <T extends HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

// ─── theme ───────────────────────────────────────────────────────────────────

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('cv-theme', theme);
  } catch {
    /* storage unavailable */
  }
  setVoltageZeroColor(theme === 'light' ? '#475569' : '#94a3b8');
  window.dispatchEvent(new CustomEvent('cv-theme', { detail: theme }));
}

// ─── shell ───────────────────────────────────────────────────────────────────

function topbar(): HTMLElement {
  const otherLang = isPT ? 'app.html' : 'app.pt.html';
  const el = h(`<header class="vw-top">
    <a class="vw-brand" href="./" title="CircuitsVibe">${BRAND_SVG}<span>CircuitsVibe</span></a>
    <span class="vw-crumb">/ <span>${esc(t('Shared circuit'))}</span> <b id="vw-crumb-name"></b></span>
    <span class="spacer"></span>
    <button class="btn" id="btn-copy" title="${esc(t('Copy link'))}">${ICON.copy}<span class="label">${esc(t('Copy link'))}</span></button>
    <button class="btn" id="btn-json" title="${esc(t('Download .circuit.json'))}">${ICON.down}<span class="label">.circuit.json</span></button>
    <button class="btn" id="btn-svg" title="${esc(t('Download SVG'))}">${ICON.down}<span class="label">SVG</span></button>
    <a class="btn outline" id="btn-editor" href="${isPT ? 'app.pt.html' : 'app.html'}" title="${esc(t('Open in the editor'))}">${ICON.edit}<span class="label">${esc(t('Open in the editor'))}</span></a>
    <a class="btn icon" href="https://github.com/felipemarts/circuit" target="_blank" rel="noopener" title="GitHub" aria-label="GitHub">${ICON.github}</a>
    <a class="btn lang-switch" href="${otherLang}${location.hash}" data-setlang="${isPT ? 'en' : 'pt'}" hreflang="${isPT ? 'en' : 'pt-BR'}">${isPT ? 'EN' : 'PT'}</a>
    <button class="btn icon theme-toggle" id="btn-theme" title="Theme" aria-label="Toggle theme">${ICON.moon}${ICON.sun}</button>
  </header>`);
  $(el, '#btn-theme').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  $(el, '.lang-switch').addEventListener('click', e => {
    try {
      localStorage.setItem('cv-lang', (e.currentTarget as HTMLElement).dataset.setlang!);
    } catch {
      /* ignore */
    }
  });
  return el;
}

function errorCard(diags: Diagnostic[], raw: string): HTMLElement {
  const items = diags
    .map(
      d => `<div class="diag ${d.severity}">
        <div class="dhead"><span class="code">${esc(d.code)}</span><span class="slug">${esc(d.slug)}</span></div>
        <div class="msg">${esc(d.message)}</div>
        ${d.note ? `<div class="dnote">${esc(d.note)}</div>` : ''}
        ${d.evidence?.path ? `<div class="dnote">at <code>${esc(String(d.evidence.path))}</code></div>` : ''}
        ${(d.fixes ?? []).length ? `<div class="fixes">${d.fixes.map(f => `<div class="fix"><span class="conf ${f.confidence}">${esc(t(f.confidence))}</span><span>${esc(f.detail)}</span></div>`).join('')}</div>` : ''}
        <div class="explain">${esc(t('explain'))}: <code>npx circuitsvibe explain ${esc(d.code)}</code></div>
      </div>`,
    )
    .join('');
  const el = h(`<section class="card err-card" role="alert">
    <div class="card-body">
      <h1><span class="x">✕</span>${esc(t('This link could not be opened'))}</h1>
      <p class="lead">${esc(t('Share links carry the whole circuit in the URL — no server, nothing stored.'))} ${raw.length > 0 ? `(${raw.length} chars)` : ''}</p>
      ${items}
      <div class="actions">
        <a class="btn primary" href="${isPT ? 'app.pt.html' : 'app.html'}">${esc(t('Open the editor instead'))}</a>
        <a class="btn outline" href="docs.html#share">${esc(t('Code'))} · docs</a>
      </div>
    </div>
  </section>`);
  return el;
}

// ─── viewer ──────────────────────────────────────────────────────────────────

interface Panels {
  tabs: HTMLElement;
  body: HTMLElement;
  add(id: string, label: string, badge?: { n: number | string; kind?: 'pass' | 'fail' | 'warn' }): HTMLElement;
  show(id: string): void;
  active(): string | undefined;
}

function makePanels(host: HTMLElement): Panels {
  const tabs = h(`<div class="tabs" role="tablist"></div>`);
  const body = h(`<div class="panels"></div>`);
  host.append(tabs, body);
  const panels = new Map<string, { tab: HTMLElement; panel: HTMLElement }>();
  const show = (id: string) => {
    for (const [k, p] of panels) {
      p.tab.setAttribute('aria-selected', String(k === id));
      p.panel.classList.toggle('active', k === id);
    }
    window.dispatchEvent(new CustomEvent('vw-tab', { detail: id }));
  };
  return {
    tabs,
    body,
    add(id, label, badge) {
      const tab = h(`<button class="tab" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="false">${esc(label)}${badge ? `<span class="n ${badge.kind ?? ''}">${esc(String(badge.n))}</span>` : ''}</button>`);
      const panel = h(`<section class="panel" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"></section>`);
      tab.addEventListener('click', () => show(id));
      tabs.appendChild(tab);
      body.appendChild(panel);
      panels.set(id, { tab, panel });
      return panel;
    },
    show,
    active: () => [...panels.entries()].find(([, p]) => p.panel.classList.contains('active'))?.[0],
  };
}

export async function mountViewer(root: HTMLElement, hash: string): Promise<void> {
  document.body.classList.add('viewer-body');
  setVoltageZeroColor(currentTheme() === 'light' ? '#475569' : '#94a3b8');
  root.innerHTML = '';
  root.appendChild(h(`<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="cvg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs></svg>`));
  const top = topbar();
  root.appendChild(top);

  // 1. decode
  let doc: CircuitDoc;
  try {
    doc = await decodeShareUrl(hash);
  } catch (err) {
    const diags: Diagnostic[] = isCircuitDocError(err) ? err.diagnostics : [{ code: 'T016', slug: 'malformed-share-link', severity: 'error', stage: 'lint', message: err instanceof Error ? err.message : String(err), fixes: [] }];
    root.appendChild(errorCard(diags, hash));
    document.title = `CircuitsVibe — ${t('This link could not be opened')}`;
    for (const id of ['#btn-json', '#btn-svg']) $(top, id).hidden = true;
    return;
  }
  const title = doc.meta?.title ?? doc.name;
  document.title = `${title} — CircuitsVibe`;
  $(top, '#vw-crumb-name').textContent = doc.name;

  // 2. layout + schematic (visible immediately)
  const layout: Layout = layoutCircuit(doc);
  const main = h(`<div class="vw-main"><div class="vw-left"></div><div class="vw-right"></div></div>`);
  root.appendChild(main);
  const left = $(main, '.vw-left');
  const right = $(main, '.vw-right');

  const verdictCard = h(`<section class="card verdict pending" aria-live="polite">
    <div class="verdict-badge"><b>…</b><span>${esc(t('Running the verification ladder…'))}</span></div>
    <div class="verdict-main">
      <h1>${esc(title)}</h1>
      ${doc.meta?.description ? `<p class="desc">${esc(doc.meta.description)}</p>` : ''}
      <div class="meaning progress"><span id="vw-progress-text">${esc(t('Simulating in your browser — nothing leaves this page.'))}</span><span class="bar"><i></i></span></div>
    </div>
    <div class="verdict-meta"><span><b>${doc.components.length}</b> ${esc(t('components'))}</span><span><b>${Object.keys(layout.netOfPin).length}</b> pins · <b>${new Set(Object.values(layout.netOfPin)).size}</b> ${esc(t('nets'))}</span>${doc.meta?.author ? `<span>${esc(doc.meta.author)}</span>` : ''}</div>
  </section>`);
  left.appendChild(verdictCard);

  const schemCard = h(`<section class="card schem-card">
    <div class="schem-tools">
      <div class="group">
        <button class="btn icon" id="z-out" title="−">${ICON.minus}</button>
        <button class="btn icon" id="z-in" title="+">${ICON.plus}</button>
        <button class="btn" id="z-fit" title="${esc(t('Fit'))} (0)">${ICON.fit}<span class="label">${esc(t('Fit'))}</span></button>
      </div>
      <div class="group" id="anim-group" hidden>
        <button class="btn icon" id="btn-play" title="${esc(t('Play'))} / ${esc(t('Pause'))} (Space)" aria-pressed="false">${ICON.play}</button>
        <select id="speed" aria-label="${esc(t('Speed'))}"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
      </div>
      <label class="time" id="time-group" hidden><span class="sr-only">${esc(t('Time'))}</span><input type="range" id="time" min="0" max="1000" step="1" value="0"><span class="readout" id="time-readout">0 s</span></label>
    </div>
    <div class="schem-wrap" id="schem-wrap">
      <div class="schem-legend" id="legend" hidden><span>${esc(t('node voltage'))}</span><span id="legend-min">−5 V</span><span class="bar" id="legend-bar"></span><span id="legend-max">+5 V</span><span class="dotk"><i></i>${esc(t('current'))}</span></div>
      <div class="schem-hint">${esc(t('Drag to pan · wheel to zoom · double-click to fit'))}</div>
      <div class="schem-note" id="schem-note" hidden></div>
    </div>
  </section>`);
  left.appendChild(schemCard);
  const wrap = $(schemCard, '#schem-wrap');
  const schematic = new Schematic(layout, wrap);
  wrap.appendChild($(schemCard, '#legend'));
  wrap.appendChild($(schemCard, '.schem-hint'));
  wrap.appendChild($(schemCard, '#schem-note'));
  $(schemCard, '#z-in').addEventListener('click', () => schematic.zoomBy(1.25));
  $(schemCard, '#z-out').addEventListener('click', () => schematic.zoomBy(0.8));
  $(schemCard, '#z-fit').addEventListener('click', () => schematic.fit());
  new ResizeObserver(() => schematic.fit()).observe(wrap);

  // header actions
  $(top, '#btn-copy').addEventListener('click', async e => {
    const b = e.currentTarget as HTMLElement;
    try {
      await navigator.clipboard.writeText(location.href);
      b.classList.add('ok');
      const label = b.querySelector('.label');
      if (label) label.textContent = t('Copied');
      setTimeout(() => {
        b.classList.remove('ok');
        if (label) label.textContent = t('Copy link');
      }, 1600);
    } catch {
      prompt(t('Copy link'), location.href);
    }
  });
  const download = (name: string, text: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $(top, '#btn-json').addEventListener('click', () => download(`${doc.name}.circuit.json`, JSON.stringify(JSON.parse(canonicalJson(doc)), null, 2), 'application/json'));
  $(top, '#btn-svg').addEventListener('click', () => download(`${doc.name}.svg`, exportSvg(schematic), 'image/svg+xml'));

  // right column: panels
  const panelCard = h(`<section class="card"></section>`);
  right.appendChild(panelCard);
  const panels = makePanels(panelCard);
  const netlistPanel = panels.add('netlist', t('Netlist'), { n: doc.components.length });
  netlistPanel.innerHTML = netlistHtml(doc, layout);
  panels.show('netlist');

  root.appendChild(h(`<footer class="vw-foot">${esc(t('Share links carry the whole circuit in the URL — no server, nothing stored.'))} · <code>npx circuitsvibe share x.bench.ts</code> · <a href="docs.html">docs</a></footer>`));

  // 3. simulate
  const progressText = $(verdictCard, '#vw-progress-text');
  const phaseLabel: Record<SimProgress['phase'], string> = {
    ladder: t('Running the verification ladder…'),
    op: t('Operating point…'),
    tran: t('Transient…'),
    ac: t('AC sweep…'),
    dc: t('DC sweep…'),
    done: '',
  };
  let sim: SimResult;
  const t0 = performance.now();
  try {
    sim = await runSimulation(doc, p => {
      progressText.textContent = `${phaseLabel[p.phase]}${p.detail ? ` ${p.detail}` : ''}`;
    });
  } catch (err) {
    verdictCard.className = 'card verdict error';
    $(verdictCard, '.verdict-badge').innerHTML = `<b>${esc(t('ERROR'))}</b><span>${esc(t('exit code'))} 3</span>`;
    $(verdictCard, '.meaning').outerHTML = `<div class="meaning"><code>T002</code> ${esc(err instanceof Error ? err.message.split('\n')[0] : String(err))}</div>`;
    return;
  }
  const wallMs = performance.now() - t0;
  presentResults(doc, layout, schematic, sim, wallMs, { verdictCard, schemCard, panels, right });
}

// ─── results ─────────────────────────────────────────────────────────────────

function presentResults(
  doc: CircuitDoc,
  layout: Layout,
  schematic: Schematic,
  sim: SimResult,
  wallMs: number,
  ui: { verdictCard: HTMLElement; schemCard: HTMLElement; panels: Panels; right: HTMLElement },
): void {
  const { record } = sim;
  const vm = verdictModel(doc, record);
  const assertions = assertionModels(doc, record);
  const diags = diagnosticModels(record);
  const ratings = ratingGroups(doc, record);
  const scope = scopeModel(doc, record, sim);
  const bode = bodeModel(record, sim);
  const dc = dcModel(doc, record, sim);
  const logic = logicModel(record, sim.tran?.logic);
  const serial = serialModels(record, sim);
  const sources = sourceModels(doc, record);

  renderVerdict(ui.verdictCard, vm, wallMs, sim);

  // chips + highlights on the schematic
  schematic.setHighlights(highlightModels(record).map(hm => ({ id: hm.id, kind: hm.kind, badge: hm.badge })));
  schematic.setChips(assertions.map(a => ({ id: a.id, anchor: a.anchor, verdict: a.verdict, text: a.chip, title: `${a.id} · ${a.probe} ${a.expected} → ${a.measured ?? '?'}` })));

  // panels (netlist already exists; insert the others before it)
  const { panels } = ui;
  const netlistTab = $(panels.tabs, '#tab-netlist');
  const netlistPanel = $(panels.body, '#panel-netlist');
  const addBefore = (id: string, label: string, badge?: { n: number | string; kind?: 'pass' | 'fail' | 'warn' }) => {
    const p = panels.add(id, label, badge);
    panels.tabs.insertBefore($(panels.tabs, `#tab-${id}`), netlistTab);
    panels.body.insertBefore(p, netlistPanel);
    return p;
  };

  const failCount = assertions.filter(a => a.verdict === 'fail').length;
  const aPanel = addBefore('assertions', t('Assertions'), { n: assertions.length ? `${assertions.length - failCount}/${assertions.length}` : 0, kind: failCount ? 'fail' : assertions.length ? 'pass' : undefined });
  renderAssertions(aPanel, assertions, schematic, panels);

  const errCount = diags.filter(d => d.severity === 'error').length;
  const dPanel = addBefore('diagnostics', t('Diagnostics'), { n: diags.length, kind: errCount ? 'fail' : diags.length ? 'warn' : undefined });
  let jumpToSource: ((loc: SourceLocation) => void) | undefined;
  renderDiagnostics(dPanel, diags, schematic, {
    locate: at => sourceLocation(at, doc),
    jump: loc => {
      panels.show('sources');
      jumpToSource?.(loc);
    },
  });

  if (ratings.length > 0) {
    const rf = ratings.filter(g => g.failed).length;
    const rPanel = addBefore('ratings', t('Ratings'), { n: rf ? `${rf} ✗` : ratings.length, kind: rf ? 'fail' : 'pass' });
    renderRatings(rPanel, ratings, schematic);
  }

  // animation + plots
  const anim = setupAnimation(doc, layout, schematic, sim, ui.schemCard);

  if (scope && scope.traces.length > 0) {
    const sPanel = addBefore('scope', t('Scope'), { n: scope.traces.length });
    sPanel.innerHTML = `<p class="lead"><b>tran</b> ${esc(scope.label)} · ${esc(t('Hover the plots for a cursor readout.'))}</p><div class="plot-wrap"><canvas class="plot" id="scope-canvas" role="img" aria-label="${esc(t('Scope'))}"></canvas></div>`;
    const scopeCanvas = $(sPanel, '#scope-canvas') as HTMLCanvasElement;
    let hoverX: number | null = null;
    const redraw = () => {
      if (!sPanel.classList.contains('active')) return;
      drawScope(scopeCanvas, scope, { cursorT: anim.time(), hoverX });
    };
    scopeCanvas.style.height = `${scopeHeight(scope)}px`;
    scopeCanvas.addEventListener('pointermove', e => {
      hoverX = e.offsetX;
      redraw();
    });
    scopeCanvas.addEventListener('pointerleave', () => {
      hoverX = null;
      redraw();
    });
    scopeCanvas.addEventListener('click', e => {
      const r = drawScope(scopeCanvas, scope, { hoverX: e.offsetX });
      if (r.hoverT !== undefined) anim.seek(r.hoverT);
    });
    anim.onFrame(redraw);
    window.addEventListener('vw-tab', redraw);
    window.addEventListener('resize', redraw);
    window.addEventListener('cv-theme', redraw);
  }

  if (bode.length > 0) {
    const bPanel = addBefore('bode', t('Bode'), { n: bode.length });
    bPanel.innerHTML = `<p class="lead"><b>ac</b> ${esc(`${eng(sim.ac[0].config.from, 'Hz')} → ${eng(sim.ac[0].config.to, 'Hz')}, ${sim.ac[0].config.pointsPerDecade}/dec`)} · ${bode.map(c => `${esc(c.probe)}${c.ref ? `/${esc(c.ref)}` : ''}`).join(', ')}</p><div class="plot-wrap"><canvas class="plot" id="bode-canvas" role="img" aria-label="Bode"></canvas></div>`;
    const c = $(bPanel, '#bode-canvas') as HTMLCanvasElement;
    c.style.height = `${bodeHeight}px`;
    let hoverX: number | null = null;
    const redraw = () => bPanel.classList.contains('active') && drawBode(c, bode, { hoverX });
    c.addEventListener('pointermove', e => {
      hoverX = e.offsetX;
      redraw();
    });
    c.addEventListener('pointerleave', () => {
      hoverX = null;
      redraw();
    });
    window.addEventListener('vw-tab', redraw);
    window.addEventListener('resize', redraw);
    window.addEventListener('cv-theme', redraw);
  }

  if (dc.length > 0) {
    const dPanel2 = addBefore('dc', t('DC sweep'), { n: dc.length });
    dPanel2.innerHTML = `<p class="lead"><b>dc</b> ${esc(dc[0].xLabel)}: ${esc(`${eng(sim.dc[0].config.from)} → ${eng(sim.dc[0].config.to)}`)} (${sim.dc[0].config.points} pts)</p><div class="plot-wrap"><canvas class="plot" id="dc-canvas" role="img" aria-label="DC sweep"></canvas></div>`;
    const c = $(dPanel2, '#dc-canvas') as HTMLCanvasElement;
    c.style.height = `${dcHeight}px`;
    let hoverX: number | null = null;
    const redraw = () => dPanel2.classList.contains('active') && drawDc(c, dc, { hoverX });
    c.addEventListener('pointermove', e => {
      hoverX = e.offsetX;
      redraw();
    });
    c.addEventListener('pointerleave', () => {
      hoverX = null;
      redraw();
    });
    window.addEventListener('vw-tab', redraw);
    window.addEventListener('resize', redraw);
    window.addEventListener('cv-theme', redraw);
  }

  if (logic && logic.signals.length > 0) {
    const lPanel = addBefore('logic', t('Logic'), { n: logic.signals.length });
    lPanel.innerHTML = `<p class="lead"><b>${esc(t('Logic analyzer'))}</b> ${esc(logic.config)}${logic.truncated.length ? ` · truncated: ${esc(logic.truncated.join(', '))}` : ''}</p><div class="plot-wrap"><canvas class="plot" id="logic-canvas" role="img" aria-label="${esc(t('Logic analyzer'))}"></canvas></div>`;
    const c = $(lPanel, '#logic-canvas') as HTMLCanvasElement;
    c.style.height = `${logicHeight(logic)}px`;
    let hoverX: number | null = null;
    const redraw = () => lPanel.classList.contains('active') && drawLogic(c, logic, { cursorT: anim.time(), hoverX });
    c.addEventListener('pointermove', e => {
      hoverX = e.offsetX;
      redraw();
    });
    c.addEventListener('pointerleave', () => {
      hoverX = null;
      redraw();
    });
    c.addEventListener('click', e => {
      const r = drawLogic(c, logic, { hoverX: e.offsetX });
      if (r.hoverT !== undefined) anim.seek(r.hoverT);
    });
    anim.onFrame(redraw);
    window.addEventListener('vw-tab', redraw);
    window.addEventListener('resize', redraw);
    window.addEventListener('cv-theme', redraw);
  }

  if (serial.length > 0) {
    const n = serial.reduce((acc, c) => acc + c.lines.length, 0);
    const sPanel = addBefore('serial', t('Serial'), { n, kind: serial.some(c => c.verdict === 'fail') ? 'fail' : serial.some(c => c.verdict === 'pass') ? 'pass' : undefined });
    renderSerial(sPanel, serial, anim, schematic);
  }

  if (sources.length > 0) {
    const marks = sources.reduce((acc, f) => acc + f.marks.length, 0);
    const srcPanel = addBefore('sources', t('Sources'), { n: marks || sources.length, kind: marks ? (sources.some(f => f.marks.some(m => m.severity === 'error')) ? 'fail' : 'warn') : undefined });
    jumpToSource = renderSources(srcPanel, sources, schematic).jumpTo;
  }

  // default tab
  if (record.verdict === 'error') panels.show('diagnostics');
  else if (ratings.some(g => g.failed) && failCount === 0) panels.show('ratings');
  else if (failCount > 0) panels.show('assertions');
  else if (scope && scope.traces.length > 0) panels.show('scope');
  else if (bode.length > 0) panels.show('bode');
  else if (dc.length > 0) panels.show('dc');
  else if (logic && logic.signals.length > 0) panels.show('logic');
  else panels.show('assertions');

  anim.start();
}

function renderVerdict(card: HTMLElement, vm: VerdictModel, wallMs: number, sim: SimResult): void {
  card.className = `card verdict ${vm.verdict}`;
  const stages = vm.stages
    .filter(s => s.verdict !== 'absent')
    .map(s => `<span class="pill stage-pill ${s.verdict}" title="${esc(s.reason ?? '')}"><i></i>${esc(s.name)}${s.count ? ` ${s.count}` : ''}${s.verdict === 'skipped' ? ` · ${esc(t('skipped'))}` : ''}</span>`)
    .join('');
  $(card, '.verdict-badge').innerHTML = `<b>${esc(t(vm.verdict.toUpperCase()))}</b><span>${esc(t('exit code'))} ${vm.exitCode}</span>`;
  const meaning = $(card, '.meaning');
  meaning.classList.remove('progress');
  meaning.innerHTML = `<code>${esc(t(vm.meaningKey))}</code>${vm.firstFailure ? ` · ${esc(t('first violation at')).replace(/ at$| em$/, '')}: <code>${esc(vm.firstFailure)}</code>` : ''}`;
  const meta = $(card, '.verdict-meta');
  const timing = Object.entries(sim.timing)
    .map(([k, v]) => `${k} ${Math.round(v)} ms`)
    .join(' · ');
  meta.innerHTML = `<span class="cli" title="runLadderAsync(benchFromDoc(doc)) — the browser runs the very same engine">${esc(t('Same result as the CLI'))}: <b>${esc(vm.verdict)}</b> · ${esc(t('exit code'))} <b>${vm.exitCode}</b> · ${esc(t('netlist hash'))} <b>${esc(vm.hash)}</b> · <b>${esc(vm.engine)}</b></span>
    <span class="stage-pills">${stages}</span>
    <span title="${esc(timing)}">${esc(t('Simulation took'))} <b>${Math.round(wallMs)} ms</b> ${esc(t('in your browser'))}</span>
    ${vm.overrides ? `<span>${esc(t('overrides'))}: <b>${esc(Object.entries(vm.overrides).map(([k, v]) => `${k}=${eng(v)}`).join(', '))}</b></span>` : ''}`;
}

function renderAssertions(panel: HTMLElement, list: AssertionModel[], schematic: Schematic, panels: Panels): void {
  if (list.length === 0) {
    panel.innerHTML = `<p class="empty">${esc(t('No assertions in this bench.'))}</p>`;
    return;
  }
  panel.innerHTML = `<p class="lead spec-kind"><b>${esc(t('simulated spec'))}</b> — ${esc(t("the bench's own expectations, evaluated by simulation"))}</p>`;
  for (const a of list) {
    const row = h(`<div class="arow ${a.verdict}" data-assertion="${esc(a.id)}" tabindex="0" role="button">
      <span class="mark">${a.verdict === 'pass' ? '✓' : '✗'}</span>
      <div class="head"><code>${esc(a.probe)}${a.ref ? ` / ${esc(a.ref)}` : ''}</code><span class="pill stage-pill ${a.verdict}"><i></i>${esc(a.stage)}</span><span class="id">${esc(a.id)}</span></div>
      <div class="vals">
        <span class="measured">${esc(t('measured'))} <b>${esc(a.measured ?? '—')}</b></span>
        <span>${esc(t('expected'))} <b>${esc(a.expected)}</b></span>
        ${a.margin ? `<span>${esc(t('margin'))} <b>${esc(a.margin)}</b></span>` : ''}
        ${a.tFirstViolation !== undefined ? `<span>${esc(t('first violation at'))} <b>${esc(secs(a.tFirstViolation))}</b></span>` : ''}
        ${a.xFirstViolation !== undefined ? `<span>${esc(t('first violation at'))} <b>x = ${esc(eng(a.xFirstViolation))}</b></span>` : ''}
      </div>
      ${a.note ? `<div class="note">${esc(a.note)}</div>` : ''}
      ${a.hintText ? `<div class="hint"><span class="conf verified">${esc(t('verified'))}</span><span><code>${esc(a.hintText)}</code><br><small>${esc(a.hint!.note)}</small></span></div>` : ''}
    </div>`);
    const focus = () => schematic.focusComponent(a.anchor.kind === 'component' ? a.anchor.id : null);
    row.addEventListener('mouseenter', focus);
    row.addEventListener('focus', focus);
    row.addEventListener('mouseleave', () => schematic.focusComponent(null));
    row.addEventListener('blur', () => schematic.focusComponent(null));
    const activate = () => {
      panel.querySelectorAll('.arow').forEach(r => r.classList.toggle('active', r === row));
      document.querySelectorAll('.schem .chip').forEach(c => c.classList.toggle('active', (c as HTMLElement).dataset.assertion === a.id));
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    panel.appendChild(row);
  }
  schematic.onChipClick = id => {
    panels.show('assertions');
    const row = panel.querySelector<HTMLElement>(`.arow[data-assertion="${id}"]`);
    if (row) {
      row.click();
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
}

function renderDiagnostics(panel: HTMLElement, list: DiagnosticModel[], schematic: Schematic, src?: { locate(at: string): SourceLocation | undefined; jump(loc: SourceLocation): void }): void {
  if (list.length === 0) {
    panel.innerHTML = `<p class="empty">${esc(t('No diagnostics — the structure is clean.'))}</p>`;
    return;
  }
  panel.innerHTML = '';
  for (const d of list) {
    const el = h(`<div class="diag ${d.severity}">
      <div class="dhead"><span class="code">${esc(d.code)}</span><span class="slug">${esc(d.slug)}</span><span class="pill stage-pill ${d.severity}"><i></i>${esc(d.stage)}</span>${d.at ? (src?.locate(d.at) ? `<button class="at-link" data-at="${esc(d.at)}" title="${esc(t('open in Sources'))}">${esc(t('at'))} ${esc(d.at)}</button>` : `<span class="slug">${esc(t('at'))} ${esc(d.at)}</span>`) : ''}</div>
      <div class="msg">${esc(d.message)}</div>
      ${d.note ? `<div class="dnote">${esc(d.note)}</div>` : ''}
      ${d.components.length || d.net ? `<div class="subjects">${d.components.map(c => `<button data-comp="${esc(c)}">${esc(c)}</button>`).join('')}${d.net ? `<button disabled>net ${esc(d.net)}</button>` : ''}</div>` : ''}
      ${d.fixes.length ? `<div class="fixes">${d.fixes.map(f => `<div class="fix"><span class="conf ${f.confidence}">${esc(t(f.confidence))}</span><span>${esc(f.detail)}${f.patch ? `<pre>${esc(f.patch)}</pre>` : ''}</span></div>`).join('')}</div>` : ''}
      <div class="explain">${esc(t('explain'))}: <code>${esc(d.explain)}</code></div>
    </div>`);
    el.querySelectorAll<HTMLElement>('[data-comp]').forEach(b => {
      b.addEventListener('mouseenter', () => schematic.focusComponent(b.dataset.comp!));
      b.addEventListener('mouseleave', () => schematic.focusComponent(null));
      b.addEventListener('click', () => schematic.focusComponent(b.dataset.comp!));
    });
    const at = el.querySelector<HTMLElement>('.at-link');
    if (at && src) {
      at.addEventListener('click', () => {
        const loc = src.locate(at.dataset.at!);
        if (loc) src.jump(loc);
      });
    }
    panel.appendChild(el);
  }
}

/**
 * Serial console: one block per microcontroller, every line with its
 * completion time. Lines not yet printed at the animation cursor are dimmed
 * ("future"), and the console follows the cursor while it plays.
 */
function renderSerial(panel: HTMLElement, consoles: SerialModel[], anim: Anim, schematic: Schematic): void {
  panel.innerHTML = `<p class="lead"><b>${esc(t('Serial console'))}</b> · ${esc(t('every line with the simulated time it was completed; lines after the cursor are dimmed'))}</p>`;
  const blocks: { el: HTMLElement; lines: { el: HTMLElement; t: number }[] }[] = [];
  for (const c of consoles) {
    const el = h(`<div class="serial ${c.verdict}">
      <div class="shead"><code>${esc(c.mcu)}</code><span class="port">Serial</span>${c.verdict !== 'none' ? `<span class="pill stage-pill ${c.verdict}"><i></i>${esc(c.verdict === 'pass' ? t('serial assertions pass') : t('serial assertion failed'))}</span>` : ''}<span class="count">${c.lines.length} ${esc(t(c.lines.length === 1 ? 'line' : 'lines'))}${c.truncated ? ` · ${esc(t('truncated'))}` : ''}</span></div>
      <div class="sbody" role="log" aria-live="off"></div>
    </div>`);
    const body = $(el, '.sbody');
    const lines: { el: HTMLElement; t: number }[] = [];
    if (c.lines.length === 0) body.appendChild(h(`<div class="sline empty">${esc(t('no output'))}</div>`));
    for (const l of c.lines) {
      const row = h(`<div class="sline${l.partial ? ' partial' : ''}" title="${esc(secs(l.t, 6))}"><span class="st">${esc(secs(l.t, 3))}</span><span class="stx">${esc(l.text)}${l.partial ? `<em> ${esc(t('(no line end yet)'))}</em>` : ''}</span></div>`);
      row.addEventListener('click', () => anim.seek(l.t));
      body.appendChild(row);
      lines.push({ el: row, t: l.t });
    }
    const head = $(el, '.shead');
    head.addEventListener('mouseenter', () => schematic.focusComponent(c.mcu));
    head.addEventListener('mouseleave', () => schematic.focusComponent(null));
    panel.appendChild(el);
    blocks.push({ el: body, lines });
  }
  let lastShown = -1;
  const follow = () => {
    if (!panel.classList.contains('active')) return;
    const tc = anim.time();
    if (tc === undefined) return;
    let shown = 0;
    for (const b of blocks) {
      let lastVisible: HTMLElement | undefined;
      for (const l of b.lines) {
        const future = l.t > tc + 1e-12;
        l.el.classList.toggle('future', future);
        if (!future) {
          lastVisible = l.el;
          shown++;
        }
      }
      if (shown !== lastShown && lastVisible) lastVisible.scrollIntoView({ block: 'nearest' });
    }
    lastShown = shown;
  };
  anim.onFrame(follow);
  window.addEventListener('vw-tab', follow);
}

/**
 * Embedded sources (firmware entry + its imports, VHDL files) with syntax
 * highlighting, line numbers and the diagnostics that point into them as
 * gutter marks. `jumpTo(loc)` (used by the Diagnostics panel) selects the
 * file and scrolls to the line.
 */
function renderSources(panel: HTMLElement, files: SourceModel[], schematic: Schematic): { jumpTo(loc: SourceLocation): void } {
  const kindLabel = (f: SourceModel) => (f.kind === 'vhdl' ? 'VHDL' : f.kind === 'firmware' ? t('firmware') : t('import'));
  panel.innerHTML = `<p class="lead"><b>${esc(t('Sources'))}</b> · ${esc(t('the firmware and VHDL files carried by this link; diagnostics with a location jump here'))}</p>
    <div class="src-tabs" role="tablist"></div><div class="src-files"></div>`;
  const tabs = $(panel, '.src-tabs');
  const host = $(panel, '.src-files');
  const views = new Map<string, { tab: HTMLElement; view: HTMLElement }>();
  const show = (path: string) => {
    for (const [p, v] of views) {
      v.tab.setAttribute('aria-selected', String(p === path));
      v.view.hidden = p !== path;
    }
  };
  for (const f of files) {
    const marksByLine = new Map<number, SourceMark[]>();
    for (const m of f.marks) marksByLine.set(m.line, [...(marksByLine.get(m.line) ?? []), m]);
    const tab = h(`<button class="src-tab" role="tab" aria-selected="false" title="${esc(f.path)}"><span class="kind">${esc(kindLabel(f))}</span>${esc(f.name)}${f.marks.length ? `<span class="n ${f.marks.some(m => m.severity === 'error') ? 'fail' : 'warn'}">${f.marks.length}</span>` : ''}</button>`);
    tab.addEventListener('click', () => show(f.path));
    tabs.appendChild(tab);
    const view = h(`<div class="src-view" hidden><div class="src-meta"><code>${esc(f.path)}</code>${f.owners.length ? `<span>${esc(t('used by'))} ${f.owners.map(o => `<button class="owner" data-comp="${esc(o)}">${esc(o)}</button>`).join(' ')}</span>` : ''}<span>${f.text.split('\n').length} ${esc(t('lines'))}</span></div><pre class="src"><code></code></pre></div>`);
    const code = $(view, 'pre.src > code');
    const lines = highlightLines(f.text, f.lang);
    const frag = document.createDocumentFragment();
    lines.forEach((html, i) => {
      const n = i + 1;
      const marks = marksByLine.get(n);
      const row = document.createElement('span');
      row.className = `ln${marks ? ` mark ${marks.some(m => m.severity === 'error') ? 'error' : 'warning'}` : ''}`;
      row.dataset.line = String(n);
      row.innerHTML = `<span class="no">${n}</span><span class="tx">${html || ' '}</span>${marks ? `<span class="mk" title="${esc(marks.map(m => `${m.code} ${m.message}`).join('\n'))}">${marks.map(m => esc(m.code)).join(' ')}</span>` : ''}`;
      frag.appendChild(row);
    });
    code.appendChild(frag);
    view.querySelectorAll<HTMLElement>('[data-comp]').forEach(b => {
      b.addEventListener('mouseenter', () => schematic.focusComponent(b.dataset.comp!));
      b.addEventListener('mouseleave', () => schematic.focusComponent(null));
    });
    host.appendChild(view);
    views.set(f.path, { tab, view });
  }
  if (files.length > 0) show(files[0].path);
  if (files.length < 2) tabs.hidden = true;
  return {
    jumpTo(loc) {
      const v = views.get(loc.path);
      if (!v) return;
      show(loc.path);
      const row = v.view.querySelector<HTMLElement>(`.ln[data-line="${loc.line}"]`);
      if (!row) return;
      v.view.querySelectorAll('.ln.flash').forEach(r => r.classList.remove('flash'));
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center' });
      setTimeout(() => row.classList.remove('flash'), 2400);
    },
  };
}


function renderRatings(panel: HTMLElement, groups: RatingGroup[], schematic: Schematic): void {
  panel.innerHTML = `<p class="lead spec-kind"><b>${esc(t('real spec'))}</b> — ${esc(t('absolute maximum ratings of catalog parts, checked after each stage'))}</p>`;
  for (const g of groups) {
    const el = h(`<div class="rgroup ${g.failed ? 'failed' : ''}">
      <div class="rhead" tabindex="0"><code>${esc(g.component)}</code><span class="part">${esc(g.part)}</span><span class="worst">${esc(t('utilization'))} ${Math.round(g.worst * 100)} %</span></div>
      <div class="rows"></div>
    </div>`);
    const rows = $(el, '.rows');
    for (const r of g.rows) {
      const u = Math.min(1, r.utilization);
      const cls = r.utilization > 1 ? 'over' : r.utilization > 0.8 ? 'warn' : 'ok';
      rows.appendChild(
        h(`<div class="rrow ${r.verdict}">
        <div class="rname"><b>${esc(r.rating)}</b><span>${esc(r.description)}</span><span class="pill stage-pill ${r.verdict}"><i></i>${esc(r.stage)}${r.measure !== 'value' ? ` · ${esc(r.measure)}` : ''}</span></div>
        <div class="rnum"><b>${esc(r.valueText)}</b> / ${esc(r.allowedText)}${r.derate !== undefined ? ` <span title="${esc(t('derated'))} ×${r.derate}">(${esc(r.limitText)} × ${r.derate})</span>` : ''} · ${Math.round(r.utilization * 100)} %</div>
        <div class="bar"><i class="${cls}" style="width:${(u * 100).toFixed(1)}%"></i>${r.utilization > 1 ? `<em style="left:${((1 / r.utilization) * 100).toFixed(1)}%"></em>` : ''}</div>
        ${r.message ? `<div class="rmsg">${esc(r.code)} · ${esc(r.message)}</div>` : ''}
        ${r.note ? `<div class="rnote">${esc(r.note)}</div>` : ''}
        ${r.fixes?.length ? `<div class="fixes">${r.fixes.map(f => `<div class="fix"><span class="conf ${f.confidence}">${esc(t(f.confidence))}</span><span>${esc(f.detail)}</span></div>`).join('')}</div>` : ''}
        ${r.hintText ? `<div class="hint"><span class="conf verified">${esc(t('verified'))}</span><code>${esc(r.hintText)}</code></div>` : ''}
        <div class="rmeta"><span>${esc(r.quantity)}</span>${r.estimated ? `<span>${esc(t('estimated'))}</span>` : ''}${r.modelEstimated ? `<span>${esc(t('model estimated'))}</span>` : ''}${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source)}</a>` : `<span>${esc(r.source)}</span>`}</div>
      </div>`),
      );
    }
    const head = $(el, '.rhead');
    head.addEventListener('mouseenter', () => schematic.focusComponent(g.component));
    head.addEventListener('mouseleave', () => schematic.focusComponent(null));
    head.addEventListener('click', () => rows.toggleAttribute('hidden'));
    panel.appendChild(el);
  }
}

function netlistHtml(doc: CircuitDoc, layout: Layout): string {
  const rows = doc.components
    .map(c => {
      const pins = Object.entries(c.pins)
        .map(([p, n]) => `<span class="pin">${esc(p)}→<b>${esc(n)}</b></span>`)
        .join(' ');
      const value = valueLabel(c) ?? '';
      return `<tr><td class="id">${esc(c.id)}</td><td>${esc(c.type)}</td><td>${esc(value)}</td><td>${pins}</td></tr>`;
    })
    .join('');
  const rails = Object.keys(layout.rails).length ? `<p class="lead">rails: ${Object.entries(layout.rails).map(([n, l]) => `<b>${esc(l)}</b> (${esc(n)})`).join(', ')}</p>` : '';
  return `${rails}<div class="netlist"><table><thead><tr><th>id</th><th>type</th><th>value</th><th>pins → nets</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ─── animation ───────────────────────────────────────────────────────────────

interface Anim {
  start(): void;
  seek(t: number): void;
  time(): number | undefined;
  onFrame(cb: () => void): void;
}

function setupAnimation(doc: CircuitDoc, layout: Layout, schematic: Schematic, sim: SimResult, card: HTMLElement): Anim {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { vmax, imax } = animationScales(sim);
  const legend = $(card, '#legend');
  const note = $(card, '#schem-note');
  const tr = sim.tran;
  const frameCbs: (() => void)[] = [];
  let tCur = 0;
  let playing = false;
  let speedMul = 1;
  let last = 0;
  let raf = 0;

  legend.hidden = false;
  $(legend, '#legend-bar').style.background = voltageGradientCSS(true);
  $(legend, '#legend-min').textContent = `−${eng(vmax, 'V')}`;
  $(legend, '#legend-max').textContent = `+${eng(vmax, 'V')}`;
  window.addEventListener('cv-theme', () => ($(legend, '#legend-bar').style.background = voltageGradientCSS(true)));

  const nets = new Set(Object.values(layout.netOfPin));
  const frame = (): FrameState => {
    const netV = new Map<string, number>();
    const pinI = new Map<string, number>();
    let logic: Map<string, LogicLevel> | undefined;
    if (tr && !tr.digitalOnly) {
      const k = indexAt(tr.t, tCur);
      for (const net of nets) {
        const ys = tr.nets[net];
        if (ys) netV.set(net, ys[k]);
      }
      for (const [ref, ys] of Object.entries(tr.pins)) pinI.set(ref, ys[k]);
    } else if (sim.op) {
      for (const [net, v] of Object.entries(sim.op.nets)) netV.set(net, v);
      for (const [ref, i] of Object.entries(sim.op.pins)) pinI.set(ref, i);
    }
    if (tr?.logic) {
      logic = new Map();
      for (const [name, changes] of Object.entries(tr.logic.signals)) logic.set(name, logicAt(changes, tCur));
    }
    return { netV, pinI, vmax, imax, logic };
  };

  const timeGroup = $(card, '#time-group');
  const animGroup = $(card, '#anim-group');
  const slider = $(card, '#time') as HTMLInputElement;
  const readout = $(card, '#time-readout');
  const playBtn = $(card, '#btn-play');
  const speedSel = $(card, '#speed') as HTMLSelectElement;
  const tEnd = tr ? tr.config.tstop : 0;
  const baseSpeed = tEnd / 8; // the whole run plays in ~8 s at 1×

  const render = () => {
    schematic.setState(frame());
    if (tr) {
      slider.value = String(Math.round((tCur / tEnd) * 1000));
      readout.textContent = secs(tCur, 3);
    }
    for (const cb of frameCbs) cb();
  };
  const setPlaying = (p: boolean) => {
    playing = p;
    playBtn.innerHTML = p ? ICON.pause : ICON.play;
    playBtn.setAttribute('aria-pressed', String(p));
    playBtn.title = p ? t('Pause') : t('Play');
  };
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    if (tr && playing) {
      tCur += dt * baseSpeed * speedMul;
      if (tCur > tEnd) tCur = 0;
      render();
    }
    if (!reduced) schematic.tick(dt * (0.6 + 0.4 * speedMul));
    raf = requestAnimationFrame(loop);
  };

  if (tr) {
    timeGroup.hidden = false;
    animGroup.hidden = false;
    slider.addEventListener('input', () => {
      tCur = (Number(slider.value) / 1000) * tEnd;
      render();
    });
    playBtn.addEventListener('click', () => setPlaying(!playing));
    speedSel.addEventListener('change', () => (speedMul = Number(speedSel.value)));
    document.addEventListener('keydown', e => {
      if (e.key === ' ' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setPlaying(!playing);
      }
    });
  } else if (sim.op) {
    note.hidden = false;
    note.textContent = t('No transient assertions — the animation shows the DC operating point.');
    setTimeout(() => (note.hidden = true), 6000);
  } else {
    note.hidden = false;
    note.textContent = t('Not simulated: fix the structural diagnostics first.');
    legend.hidden = true;
  }
  if (reduced) {
    const n = $(card, '#schem-note');
    n.hidden = false;
    n.textContent = t('reduced motion: the animation is paused');
  }

  return {
    start() {
      // Start a bit into the run so the first frame already shows activity.
      if (tr) tCur = Math.min(tEnd * 0.35, tEnd);
      render();
      if (tr && !reduced) setPlaying(true);
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    },
    seek(tt: number) {
      tCur = Math.max(0, Math.min(tEnd, tt));
      render();
    },
    time: () => (tr ? tCur : undefined),
    onFrame: cb => frameCbs.push(cb),
  };
}

// ─── svg export ──────────────────────────────────────────────────────────────

function exportSvg(schematic: Schematic): string {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const style = `<style>
    .sym{stroke:${v('--sym')};fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sym-fill{fill:${v('--sym-fill')}}
    .ic-body{fill:${v('--panel-2')}}.wire,.stub{stroke:${v('--wire')};fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .junction{fill:${v('--wire')}}.nc{stroke:${v('--dim')};stroke-width:1.4}.rail-txt{font:600 10px ${v('--mono')};fill:${v('--muted')}}
    .lbl{font:600 11px ${v('--mono')};fill:${v('--lbl')}}.lbl-val{font:500 10px ${v('--mono')};fill:${v('--lbl-val')}}
    .sym-txt{font:9px ${v('--mono')};fill:${v('--muted')}}.ic-title{font:700 11px ${v('--mono')};fill:${v('--text')}}.ic-sub{font-size:8.5px;fill:${v('--dim')}}
    .pin-name{font-size:8px}.pin-num{font-size:7px;fill:${v('--dim')}}.gate-txt{font:700 8px ${v('--mono')}}.wave{stroke:${v('--accent')};stroke-width:1.4}.wave-txt{fill:${v('--accent')};font:700 9px ${v('--mono')}}
    .body-diode{stroke:${v('--dim')};stroke-width:1}.led-glow{fill:${v('--led')};opacity:0}.net-caption{font:600 10px ${v('--mono')};fill:${v('--accent')}}
    .flag-body{fill:${v('--bg-2')};stroke:${v('--accent')};stroke-width:1.2}.flag-txt{font:600 9.5px ${v('--mono')};fill:${v('--accent')}}
    .dot{fill:${v('--dot')}}.chip rect{fill:${v('--panel')};stroke-width:1.2}.chip-pass rect{stroke:${v('--green')}}.chip-fail rect{stroke:${v('--red')}}
    .chip text{font:600 9.5px ${v('--mono')};fill:${v('--text')}}.chip-pass .chip-mark{fill:${v('--green')}}.chip-fail .chip-mark{fill:${v('--red')}}
    .hl{fill:none;stroke-width:2;stroke-dasharray:6 4}.hl-error{stroke:${v('--red')}}.hl-warning{stroke:${v('--amber')}}.hl-rating{stroke:${v('--red')}}
    .hl-badge rect{fill:${v('--red')}}.hl-badge text{font:700 9.5px ${v('--mono')};fill:#0b1120}
    .board-body{fill:${v('--panel-2')}}.vhdl-body{fill:${v('--panel-2')}}.board-header{fill:${v('--border')};stroke-width:.8}.board-usb{fill:${v('--bg-2')};stroke-width:1}.board-icsp{fill:${v('--dim')};stroke:none}
    .board-txt{font:700 6.5px ${v('--mono')};fill:${v('--dim')}}.bus-bracket{stroke:${v('--dim')};stroke-width:1}.bus-name{font:700 8px ${v('--mono')};fill:${v('--accent')}}
  </style>`;
  const svg = schematic.toSvgString();
  return svg.replace(/<defs>/, `${style}<rect width="100%" height="100%" fill="${v('--bg-2')}"/><defs>`).replace(/<svg /, `<svg xmlns="http://www.w3.org/2000/svg" `);
}
