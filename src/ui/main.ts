import {
  type PlacedComponent, type Wire, type GroundNode, type ToolType, type ComponentType, type Point,
  type Probe, type PinDef, type ProjectData,
  COMPONENT_DEFS, GRID_SIZE, formatValue, getPinWorldPos, PROBE_COLORS,
  getComponentDef, customComponentDefs,
} from './types';
import {
  drawGrid, drawComponent, drawComponentMask, drawWirePath, drawWirePreviewPath, drawGroundSymbol,
  drawPinHighlight, drawProbeMarker, hitTestPin, hitTestComponent,
  buildComponentObstacles, routeWire, pathToSegments,
  type Segment,
} from './renderer';
import { drawChart, type WaveformData } from './chartRenderer';
import { showScopeOverlay, hideScopeOverlay } from './scopeOverlay';
import { Circuit } from '../core/Circuit';
import { Component } from '../core/Component';
import { Resistor } from '../components/Resistor';
import { VoltageSource } from '../components/VoltageSource';
import { CurrentSource } from '../components/CurrentSource';
import { Capacitor } from '../components/Capacitor';
import { Inductor } from '../components/Inductor';
import { Diode } from '../components/Diode';
import { LED } from '../components/LED';
import { Switch } from '../components/Switch';
import { Button } from '../components/Button';
import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import { defineComponent as realDefineComponent, CustomComponent } from '../core/CustomComponent';
import type { ComponentDef } from '../core/CustomComponent';
import type { ProbeSpec, TransientResult } from '../analysis/TransientAnalysis';
import { TransientSession } from '../analysis/TransientSession';
import { initCodeEditor, type CodeEditorAPI } from './codeEditor';
import { initProjectManager, type ProjectBridge } from './projectManager';
import { autoSave, loadAutoSave, clearAutoSave } from './projectStore';

// ─── State ───────────────────────────────────────────────────────────────────

let components: PlacedComponent[] = [];
let wires: Wire[] = [];
let grounds: GroundNode[] = [];
let probes: Probe[] = [];

let currentTool: ToolType = 'select';
let selectedId: string | null = null;
let selectedWireId: string | null = null;
let hoveredPin: { componentId: string; pinName: string } | null = null;
let dragging: { componentId: string; offsetX: number; offsetY: number } | null = null;
let dragHasMoved = false;
// Button currently held closed by mouse-down. Released on mouseup anywhere.
let pressedButtonId: string | null = null;
let wireStart: { componentId: string; pinName: string } | null = null;
// Pending wire-drag: set on mousedown over a wire; converted to either a
// "select" (mouseup with no movement) or a "drag the wire path" (mouseup with
// movement past the threshold). `orientation` records whether the clicked
// segment was horizontal ('h') or vertical ('v') so the drag can move the
// segment along its perpendicular axis only.
let wireDragInit: {
  wireId: string;
  hitX: number;
  hitY: number;
  mouseX: number;
  mouseY: number;
  orientation: 'h' | 'v';
} | null = null;
// `axis` is the constraint axis: 'y' = horizontal segment moved up/down,
// 'x' = vertical segment moved left/right.
let wireDragging: { wireId: string; axis: 'x' | 'y' } | null = null;
const DRAG_THRESHOLD_PX = 4;
let mousePos: Point = { x: 0, y: 0 };
let showResults = false;
let nextId = 1;
let transientResult: TransientResult | null = null;

// Pan & Zoom state
let panX = 0;
let panY = 0;
let zoom = 1;
let panning: { startX: number; startY: number; panStartX: number; panStartY: number } | null = null;

// Continuous simulation state (consumed by render() so must be hoisted here)
let simSession: TransientSession | null = null;
// Simulation components include both TwoTerminalComponents and Switch (3-pin).
// All exposed types provide voltage/current getters for live UI display.
type SimComponent = TwoTerminalComponent | Switch;
let simSimComponents: Map<string, SimComponent> | null = null;
let simProbeLabels: { label: string; color: string }[] = [];
let simAnimFrame: number | null = null;
let simLastWallTime = 0;
let simChartLastUpdate = 0;

// Per-wire flow animation state (accumulated phase, smoothed current)
const wireFlowPhase = new Map<string, number>();
const wireSmoothCurrent = new Map<string, number>();
let lastRenderTime = 0;
// Envelope of the circuit's max current for relative speed scaling.
// Attack is instant; release decays over ~1.5 s so a freshly-opened switch
// doesn't immediately make the rest of the (stale) circuit look maxed-out.
let circuitMaxEnvelope = 0;

// Cached A* paths — recomputed only when topology/positions actually change
let pathsCacheHash = '';
let pathsCache: Point[][] = [];

// Per-wire current "spec": list of components whose current contributes,
// each with a sign, plus a divisor for multi-bridge cases.
// Computed via DFS+KCL whenever topology changes.
type WireContribution = { componentId: string; sign: 1 | -1 };
type WireFlowSpec = { contribs: WireContribution[]; divisor: number };
let wireFlowSpecs = new Map<string, WireFlowSpec>();

/** Convert screen coordinates to world coordinates */
function screenToWorld(sx: number, sy: number): Point {
  return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}

/** Convert world coordinates to screen coordinates */
function worldToScreen(wx: number, wy: number): Point {
  return { x: wx * zoom + panX, y: wy * zoom + panY };
}

// ─── Canvas setup ────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusText = document.getElementById('status-text')!;
const mouseXEl = document.getElementById('mouse-x')!;
const mouseYEl = document.getElementById('mouse-y')!;
const zoomLevelEl = document.getElementById('zoom-level')!;
const propsContent = document.getElementById('props-content')!;
const resultsDiv = document.getElementById('results')!;
const bottomPanel = document.getElementById('bottom-panel')!;
const chartCanvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
const chartCtx = chartCanvas.getContext('2d')!;
const consoleOutput = document.getElementById('console-output')!;
const editorContent = document.getElementById('editor-content')!;

// Initialize multi-file code editor
const editorAPI: CodeEditorAPI = initCodeEditor(editorContent);

// Set default content for main.js
const DEFAULT_CODE = `const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(10);
const r1 = new Resistor(1);
const l1 = new Inductor(0.001);
const c1 = new Capacitor(0.00001);

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(l1.pin('1'));
l1.pin('2').connect(c1.pin('1'));
c1.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

circuit.probe(c1, 'voltage');

circuit.analyze('transient', {
  timeStep: 1e-6,
  duration: 5e-3,
});`;

// Project name
let projectName = 'Sem titulo';

function resize() {
  const canvasArea = canvas.parentElement!;
  canvas.width = canvasArea.clientWidth;
  canvas.height = canvasArea.clientHeight - bottomPanel.offsetHeight;
  // Resize chart canvas if chart tab is active
  const chartContent = document.getElementById('chart-content')!;
  if (chartContent.classList.contains('active')) {
    chartCanvas.width = chartContent.clientWidth;
    chartCanvas.height = chartContent.clientHeight;
    renderChart();
  }
  render();
}
window.addEventListener('resize', resize);
// Fallback: release a held button even if mouseup happens outside the canvas
window.addEventListener('mouseup', () => {
  if (pressedButtonId) {
    const btn = components.find(c => c.id === pressedButtonId);
    if (btn) {
      btn.closed = false;
      syncComponentStateToSim(btn);
    }
    pressedButtonId = null;
    render();
  }
});
resize();

// ─── Toolbar ─────────────────────────────────────────────────────────────────

const toolbar = document.getElementById('toolbar')!;
toolbar.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!btn) return;

  // Handle rotate button
  if (btn.id === 'btn-rotate') {
    rotateSelected();
    return;
  }

  if (!btn.dataset.tool) return;

  currentTool = btn.dataset.tool as ToolType;
  toolbar.querySelectorAll('button[data-tool]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  wireStart = null;
  updateStatus();
});

document.getElementById('btn-play')!.addEventListener('click', togglePlay);
document.getElementById('btn-demo')!.addEventListener('click', loadDemoRLC);
document.getElementById('btn-clear')!.addEventListener('click', () => {
  stopSimulation();
  components = [];
  wires = [];
  grounds = [];
  probes = [];
  selectedId = null;
  showResults = false;
  transientResult = null;
  hideScopeOverlay();
  updateProps();
  updateResults();
  resize();
});

// Time scale slider: value = log10(seconds simulated per second of wall time)
const timeScaleSlider = document.getElementById('time-scale') as HTMLInputElement;
const timeScaleValueEl = document.getElementById('time-scale-value')!;
let timeScale = Math.pow(10, parseFloat(timeScaleSlider.value));
function formatTimeScale(s: number): string {
  if (s >= 1) return `${s.toFixed(s >= 10 ? 0 : 1)} s/s`;
  if (s >= 1e-3) return `${(s * 1e3).toFixed(s >= 0.01 ? 0 : 1)} ms/s`;
  return `${(s * 1e6).toFixed(0)} µs/s`;
}
timeScaleSlider.addEventListener('input', () => {
  timeScale = Math.pow(10, parseFloat(timeScaleSlider.value));
  timeScaleValueEl.textContent = formatTimeScale(timeScale);
});
timeScaleValueEl.textContent = formatTimeScale(timeScale);

document.getElementById('scope-close')?.addEventListener('click', hideScopeOverlay);

function rotateSelected() {
  if (selectedId) {
    const comp = components.find(c => c.id === selectedId);
    if (comp) {
      comp.rotation = (comp.rotation + 90) % 360;
      showResults = false;
      updateProps();
      render();
    }
  }
}

document.getElementById('btn-rotate')?.addEventListener('click', rotateSelected);

// ─── Value dialog ────────────────────────────────────────────────────────────

function promptValue(title: string, defaultVal: string): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = document.getElementById('value-dialog')!;
    const input = document.getElementById('dialog-input') as HTMLInputElement;
    const titleEl = document.getElementById('dialog-title')!;

    titleEl.textContent = title;
    input.value = defaultVal;
    dialog.classList.add('visible');
    input.focus();
    input.select();

    function close(value: string | null) {
      dialog.classList.remove('visible');
      document.getElementById('dialog-ok')!.removeEventListener('click', onOk);
      document.getElementById('dialog-cancel')!.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(value);
    }

    function onOk() { close(input.value); }
    function onCancel() { close(null); }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    }

    document.getElementById('dialog-ok')!.addEventListener('click', onOk);
    document.getElementById('dialog-cancel')!.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ─── Mouse events ────────────────────────────────────────────────────────────

function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;
  const world = screenToWorld(screenX, screenY);
  mousePos = world;
  mouseXEl.textContent = String(snap(world.x));
  mouseYEl.textContent = String(snap(world.y));

  // Handle panning (middle mouse or space+drag)
  if (panning) {
    panX = panning.panStartX + (screenX - panning.startX);
    panY = panning.panStartY + (screenY - panning.startY);
    render();
    return;
  }

  if (dragging) {
    const comp = components.find(c => c.id === dragging!.componentId)!;
    const newX = snap(world.x - dragging.offsetX);
    const newY = snap(world.y - dragging.offsetY);
    if (newX !== comp.x || newY !== comp.y) {
      comp.x = newX;
      comp.y = newY;
      dragHasMoved = true;
    }
    render();
    return;
  }

  // Live drag of an existing wire: update the constraint axis each frame
  if (wireDragging) {
    const wire = wires.find(w => w.id === wireDragging!.wireId);
    if (wire) {
      const value = wireDragging.axis === 'y' ? snap(world.y) : snap(world.x);
      wire.via = { axis: wireDragging.axis, value };
      invalidate();
      render();
    }
    return;
  }

  // Promote a pending wire-drag once the mouse leaves the click threshold
  if (wireDragInit) {
    const dx = world.x - wireDragInit.mouseX;
    const dy = world.y - wireDragInit.mouseY;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
      // 'h' segment is moved along Y → axis 'y'; 'v' segment along X → axis 'x'
      const axis: 'x' | 'y' = wireDragInit.orientation === 'h' ? 'y' : 'x';
      wireDragging = { wireId: wireDragInit.wireId, axis };
      selectedWireId = wireDragInit.wireId;
      selectedId = null;
      wireDragInit = null;
      updateProps();
      render();
      return;
    }
  }

  hoveredPin = null;
  for (const comp of components) {
    const pinName = hitTestPin(comp, world.x, world.y);
    if (pinName) {
      hoveredPin = { componentId: comp.id, pinName };
      break;
    }
  }

  // Cursor feedback: when wire tool is active and the pointer is on a wire,
  // show a directional resize cursor signalling the wire can be tapped/dragged.
  let cursor = 'crosshair';
  if (currentTool === 'wire' && !hoveredPin) {
    const wireHit = hitTestWire(world.x, world.y);
    if (wireHit) cursor = wireHit.orientation === 'h' ? 'ns-resize' : 'ew-resize';
  }
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;

  render();
});

canvas.addEventListener('mousedown', (e) => {
  // Middle mouse button or space+left → start panning
  if (e.button === 1) {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    panning = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      panStartX: panX,
      panStartY: panY,
    };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (e.button !== 0) return;
  const x = mousePos.x;
  const y = mousePos.y;

  if (currentTool === 'probe') {
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, x, y);
      if (pinName) {
        // Toggle probe
        const existing = probes.findIndex(p => p.componentId === comp.id && p.pinName === pinName);
        if (existing >= 0) {
          probes.splice(existing, 1);
        } else {
          const color = PROBE_COLORS[probes.length % PROBE_COLORS.length];
          probes.push({
            id: `p${nextId++}`,
            componentId: comp.id,
            pinName,
            type: 'voltage',
            color,
            label: `V(${comp.label}.${pinName})`,
          });
        }
        render();
        return;
      }
    }
    return;
  }

  if (currentTool === 'select') {
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, x, y);
      if (pinName) {
        wireStart = { componentId: comp.id, pinName };
        updateStatus();
        return;
      }
    }
    for (const comp of [...components].reverse()) {
      if (hitTestComponent(comp, x, y)) {
        selectedId = comp.id;
        selectedWireId = null;
        dragging = { componentId: comp.id, offsetX: x - comp.x, offsetY: y - comp.y };
        dragHasMoved = false;
        // Button: mousedown holds it closed; released on mouseup
        if (comp.type === 'Button') {
          comp.closed = true;
          pressedButtonId = comp.id;
          syncComponentStateToSim(comp);
        }
        updateProps();
        render();
        return;
      }
    }
    // Click on a wire — arm pending drag (mouseup without drag = select)
    const wireHit = hitTestWire(x, y);
    if (wireHit) {
      wireDragInit = {
        wireId: wireHit.wireId,
        hitX: wireHit.px,
        hitY: wireHit.py,
        mouseX: x,
        mouseY: y,
        orientation: wireHit.orientation,
      };
      return;
    }
    selectedId = null;
    selectedWireId = null;
    updateProps();
    render();
    return;
  }

  if (currentTool === 'wire') {
    // First try clicking on a pin
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, x, y);
      if (pinName) {
        if (!wireStart) {
          wireStart = { componentId: comp.id, pinName };
          updateStatus();
        } else {
          if (wireStart.componentId !== comp.id || wireStart.pinName !== pinName) {
            wires.push({ id: `w${nextId++}`, from: wireStart, to: { componentId: comp.id, pinName } });
            invalidate();
          }
          wireStart = null;
          updateStatus();
        }
        render();
        return;
      }
    }

    // Otherwise, clicking on an existing wire either starts a T-tap (if a
    // wireStart is in progress) or arms a wire-drag (creates a junction +
    // dragging when the mouse moves beyond the threshold).
    const wireHit = hitTestWire(x, y);
    if (wireHit) {
      if (wireStart) {
        // Mid-wire T-tap: terminate at a new junction on the existing wire
        const targetWire = wires[wireHit.index];
        const jx = snap(wireHit.px);
        const jy = snap(wireHit.py);
        const junction: PlacedComponent = {
          id: `c${nextId++}`, type: 'Junction', x: jx, y: jy, rotation: 0, value: 0,
          label: '', pins: [...COMPONENT_DEFS.Junction.pins],
        };
        components.push(junction);
        const origFrom = targetWire.from;
        const origTo = targetWire.to;
        wires.splice(wireHit.index, 1);
        wires.push({ id: `w${nextId++}`, from: origFrom, to: { componentId: junction.id, pinName: '1' } });
        wires.push({ id: `w${nextId++}`, from: { componentId: junction.id, pinName: '1' }, to: origTo });
        wires.push({ id: `w${nextId++}`, from: wireStart, to: { componentId: junction.id, pinName: '1' } });
        wireStart = null;
        invalidate();
        updateStatus();
        render();
        return;
      }
      // No wireStart yet → arm a drag (becomes a wire-path move on mouse-move,
      // or a T-tap junction if mouseup happens with no movement)
      wireDragInit = {
        wireId: wireHit.wireId,
        hitX: wireHit.px,
        hitY: wireHit.py,
        mouseX: x,
        mouseY: y,
        orientation: wireHit.orientation,
      };
      return;
    }

    if (wireStart) {
      wireStart = null;
      updateStatus();
      render();
    }
    return;
  }

  placeComponent(currentTool as ComponentType, snap(x), snap(y));
});

canvas.addEventListener('mouseup', (e) => {
  if (panning) {
    panning = null;
    canvas.style.cursor = 'crosshair';
    return;
  }

  if (dragging) {
    const comp = components.find(c => c.id === dragging!.componentId);
    // Click-without-drag on a Switch toggles it
    if (comp && comp.type === 'Switch' && !dragHasMoved) {
      comp.closed = !comp.closed;
      syncComponentStateToSim(comp);
      render();
    }
    dragging = null;
    dragHasMoved = false;
    // Always release any pressed button on mouseup
    if (pressedButtonId) {
      const btn = components.find(c => c.id === pressedButtonId);
      if (btn) {
        btn.closed = false;
        syncComponentStateToSim(btn);
      }
      pressedButtonId = null;
      render();
    }
    return;
  }
  // Mouseup with no dragging: still release any pressed button (safety)
  if (pressedButtonId) {
    const btn = components.find(c => c.id === pressedButtonId);
    if (btn) {
      btn.closed = false;
      syncComponentStateToSim(btn);
    }
    pressedButtonId = null;
    render();
  }

  // Wire being actively dragged → release
  if (wireDragging) {
    wireDragging = null;
    return;
  }

  // Click-without-drag on a wire: select tool selects, wire tool creates a junction
  if (wireDragInit) {
    if (currentTool === 'wire') {
      const targetIdx = wires.findIndex(w => w.id === wireDragInit!.wireId);
      const targetWire = targetIdx >= 0 ? wires[targetIdx] : null;
      if (targetWire) {
        const jx = snap(wireDragInit.hitX);
        const jy = snap(wireDragInit.hitY);
        const junction: PlacedComponent = {
          id: `c${nextId++}`, type: 'Junction', x: jx, y: jy, rotation: 0, value: 0,
          label: '', pins: [...COMPONENT_DEFS.Junction.pins],
        };
        components.push(junction);
        const origFrom = targetWire.from;
        const origTo = targetWire.to;
        wires.splice(targetIdx, 1);
        wires.push({ id: `w${nextId++}`, from: origFrom, to: { componentId: junction.id, pinName: '1' } });
        wires.push({ id: `w${nextId++}`, from: { componentId: junction.id, pinName: '1' }, to: origTo });
        selectedId = junction.id;
        selectedWireId = null;
        invalidate();
        updateProps();
      }
    } else {
      // select tool (and others): just select the wire
      selectedWireId = wireDragInit.wireId;
      selectedId = null;
      updateProps();
    }
    wireDragInit = null;
    render();
    return;
  }

  if (wireStart && currentTool === 'select') {
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, mousePos.x, mousePos.y);
      if (pinName && (wireStart.componentId !== comp.id || wireStart.pinName !== pinName)) {
        wires.push({ id: `w${nextId++}`, from: wireStart, to: { componentId: comp.id, pinName } });
        invalidate();
        break;
      }
    }
    wireStart = null;
    updateStatus();
    render();
  }
});

// Right-click context: rotate
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

  for (const comp of [...components].reverse()) {
    if (hitTestComponent(comp, world.x, world.y)) {
      selectedId = comp.id;
      comp.rotation = (comp.rotation + 90) % 360;
      invalidate();
      updateProps();
      render();
      return;
    }
  }
});

// Zoom with mouse wheel
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;

  // World point under cursor before zoom
  const worldBefore = screenToWorld(screenX, screenY);

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  zoom = Math.max(0.2, Math.min(5, zoom * factor));

  // Adjust pan so the world point stays under cursor
  panX = screenX - worldBefore.x * zoom;
  panY = screenY - worldBefore.y * zoom;

  zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
  render();
}, { passive: false });

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (document.getElementById('value-dialog')!.classList.contains('visible')) return;
  if ((document.activeElement as HTMLElement)?.id === 'code-editor') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedId) {
      components = components.filter(c => c.id !== selectedId);
      wires = wires.filter(w => {
        const from = w.from as { componentId?: string };
        const to = w.to as { componentId?: string };
        return from.componentId !== selectedId && to.componentId !== selectedId;
      });
      grounds = grounds.filter(g => g.componentId !== selectedId);
      probes = probes.filter(p => p.componentId !== selectedId);
      selectedId = null;
      invalidate();
      updateProps();
      render();
    } else if (selectedWireId) {
      wires = wires.filter(w => w.id !== selectedWireId);
      selectedWireId = null;
      invalidate();
      render();
    }
  }

  if (e.key === 'r' || e.key === 'R') {
    rotateSelected();
  }

  if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    togglePlay();
  }

  if (e.key === 'Escape') {
    wireStart = null;
    selectedId = null;
    updateProps();
    updateStatus();
    render();
  }
});

// ─── Component placement ─────────────────────────────────────────────────────

async function placeComponent(type: ComponentType, x: number, y: number) {
  const def = COMPONENT_DEFS[type];

  let value = def.defaultValue;
  if (def.unit) {
    const result = await promptValue(`Valor do ${type}`, String(def.defaultValue));
    if (result === null) return;
    value = parseFloat(result);
    if (isNaN(value) || value <= 0) {
      statusText.textContent = 'Valor invalido';
      return;
    }
  }

  const count = components.filter(c => c.type === type).length + 1;
  const comp: PlacedComponent = {
    id: `c${nextId++}`, type, x, y, rotation: 0, value,
    label: def.label ? `${def.label}${count}` : '',
    pins: [...def.pins],
  };

  components.push(comp);
  selectedId = comp.id;
  invalidate();
  updateProps();
  render();
}

// ─── Properties panel ────────────────────────────────────────────────────────

function updateProps() {
  if (!selectedId) {
    propsContent.innerHTML = '<p style="color:#475569; font-size:12px;">Selecione um componente</p>';
    return;
  }

  const comp = components.find(c => c.id === selectedId);
  if (!comp) return;

  const def = getComponentDef(comp.type);
  let html = `
    <div class="prop-group">
      <label>Tipo</label>
      <input type="text" value="${comp.type}" readonly style="opacity:0.5" />
    </div>
    <div class="prop-group">
      <label>Nome</label>
      <input type="text" id="prop-label" value="${comp.label}" />
    </div>`;

  if (def?.unit) {
    html += `
    <div class="prop-group">
      <label>Valor (${def.unit})</label>
      <input type="number" id="prop-value" value="${comp.value}" step="any" />
    </div>`;
  }

  // AC parameters for VoltageSource
  if (comp.type === 'VoltageSource') {
    html += `
    <div class="prop-group">
      <label>Amplitude AC (V)</label>
      <input type="number" id="prop-ac-amp" value="${comp.acAmplitude ?? 0}" step="any" />
    </div>
    <div class="prop-group">
      <label>Frequencia (Hz)</label>
      <input type="number" id="prop-freq" value="${comp.frequency ?? 0}" step="any" />
    </div>`;
  }

  html += `
    <div class="prop-group">
      <label>Rotacao (graus)</label>
      <div style="display:flex;gap:4px;">
        <input type="number" id="prop-rotation" value="${comp.rotation}" step="90" style="flex:1" />
        <button id="prop-rotate-btn" style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:14px">&#8635;</button>
      </div>
    </div>
    <div class="prop-group" style="margin-top:12px">
      <button onclick="document.dispatchEvent(new CustomEvent('delete-selected'))"
        style="background:#dc2626;border:none;color:white;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;width:100%">
        Excluir
      </button>
    </div>`;

  propsContent.innerHTML = html;

  const labelInput = document.getElementById('prop-label') as HTMLInputElement;
  const valueInput = document.getElementById('prop-value') as HTMLInputElement | null;
  const rotInput = document.getElementById('prop-rotation') as HTMLInputElement;
  const rotBtn = document.getElementById('prop-rotate-btn');
  const acAmpInput = document.getElementById('prop-ac-amp') as HTMLInputElement | null;
  const freqInput = document.getElementById('prop-freq') as HTMLInputElement | null;

  labelInput?.addEventListener('change', () => { comp.label = labelInput.value; render(); });
  valueInput?.addEventListener('change', () => {
    const v = parseFloat(valueInput.value);
    if (!isNaN(v) && v > 0) { comp.value = v; invalidate(); render(); }
  });
  rotInput?.addEventListener('change', () => {
    comp.rotation = ((parseInt(rotInput.value) || 0) % 360 + 360) % 360;
    invalidate(); render();
  });
  rotBtn?.addEventListener('click', () => {
    comp.rotation = (comp.rotation + 90) % 360;
    rotInput.value = String(comp.rotation);
    invalidate(); render();
  });
  acAmpInput?.addEventListener('change', () => {
    comp.acAmplitude = parseFloat(acAmpInput.value) || 0;
    invalidate();
  });
  freqInput?.addEventListener('change', () => {
    comp.frequency = parseFloat(freqInput.value) || 0;
    invalidate();
  });
}

document.addEventListener('delete-selected', () => {
  if (selectedId) {
    components = components.filter(c => c.id !== selectedId);
    wires = wires.filter(w => {
      const from = w.from as { componentId?: string };
      const to = w.to as { componentId?: string };
      return from.componentId !== selectedId && to.componentId !== selectedId;
    });
    grounds = grounds.filter(g => g.componentId !== selectedId);
    probes = probes.filter(p => p.componentId !== selectedId);
    selectedId = null;
    invalidate();
    updateProps();
    render();
  }
});

// ─── Build circuit helper ────────────────────────────────────────────────────

function buildCircuit() {
  const circuit = new Circuit();
  const simComponents = new Map<string, SimComponent>();

  for (const comp of components) {
    if (comp.type === 'Ground' || comp.type === 'Junction') continue;
    let simComp: SimComponent;
    switch (comp.type) {
      case 'Resistor': simComp = new Resistor(comp.value); break;
      case 'VoltageSource': {
        const vs = new VoltageSource(comp.value);
        vs.acAmplitude = comp.acAmplitude ?? 0;
        vs.frequency = comp.frequency ?? 0;
        simComp = vs;
        break;
      }
      case 'CurrentSource': simComp = new CurrentSource(comp.value); break;
      case 'Capacitor': simComp = new Capacitor(comp.value); break;
      case 'Inductor': simComp = new Inductor(comp.value); break;
      case 'Diode': simComp = new Diode(); break;
      case 'LED': simComp = new LED(); break;
      case 'Switch': simComp = new Switch(!!comp.closed); break;
      case 'Button': simComp = new Button(!!comp.closed); break;
      default: continue; // Skip custom components in visual-only simulation
    }
    simComponents.set(comp.id, simComp!);
  }

  // Cluster pins into electrical nodes via union-find: wires + ground markers
  // unify pin keys. Ground/Junction pins act as passthroughs — multiple wires
  // touching them all end up in the same cluster.
  const compById = new Map<string, PlacedComponent>();
  for (const c of components) compById.set(c.id, c);

  const ufParent = new Map<string, string>();
  const ufFind = (x: string): string => {
    let p = ufParent.get(x);
    if (p === undefined) { ufParent.set(x, x); return x; }
    if (p === x) return x;
    const r = ufFind(p);
    ufParent.set(x, r);
    return r;
  };
  const ufUnion = (a: string, b: string) => {
    const ra = ufFind(a), rb = ufFind(b);
    if (ra !== rb) ufParent.set(ra, rb);
  };

  const GROUND_ROOT = '__GROUND_CLUSTER__';
  ufFind(GROUND_ROOT);
  for (const c of components) {
    if (c.type === 'Ground') {
      ufUnion(`${c.id}:1`, GROUND_ROOT);
    }
  }

  for (const wire of wires) {
    const f = wire.from as { componentId: string; pinName: string };
    const t = wire.to as { componentId: string; pinName: string };
    if (!compById.has(f.componentId) || !compById.has(t.componentId)) continue;
    ufUnion(`${f.componentId}:${f.pinName}`, `${t.componentId}:${t.pinName}`);
  }
  // Legacy ground markers
  for (const gnd of grounds) {
    if (compById.has(gnd.componentId)) {
      ufUnion(`${gnd.componentId}:${gnd.pinName}`, GROUND_ROOT);
    }
  }

  // For each cluster, connect all real component pins together (and to ground
  // if it's the ground cluster).
  const clusterPins = new Map<string, { compId: string; pinName: string }[]>();
  for (const c of components) {
    if (!simComponents.has(c.id)) continue; // skip Ground / Junction / custom
    for (const pin of c.pins) {
      const root = ufFind(`${c.id}:${pin.name}`);
      if (!clusterPins.has(root)) clusterPins.set(root, []);
      clusterPins.get(root)!.push({ compId: c.id, pinName: pin.name });
    }
  }

  const groundRoot = ufFind(GROUND_ROOT);
  for (const [root, pins] of clusterPins) {
    if (pins.length === 0) continue;
    if (root === groundRoot) {
      for (const p of pins) {
        simComponents.get(p.compId)!.pin(p.pinName).connect(circuit.ground);
      }
    } else {
      const head = simComponents.get(pins[0].compId)!.pin(pins[0].pinName);
      for (let i = 1; i < pins.length; i++) {
        head.connect(simComponents.get(pins[i].compId)!.pin(pins[i].pinName));
      }
    }
  }

  return { circuit, simComponents };
}

function hasAnyGround(): boolean {
  if (grounds.length > 0) return true;
  return components.some(c => c.type === 'Ground');
}

/** Mirror Switch/Button state from the canvas component to its sim instance,
 * so toggling them mid-simulation takes effect without restarting. */
function syncComponentStateToSim(comp: PlacedComponent): void {
  if (!simSimComponents) return;
  const sc = simSimComponents.get(comp.id);
  if (!sc) return;
  if (sc instanceof Switch) {
    sc.closed = !!comp.closed;
    // SPDT polarity flips with state — re-derive wire-flow contributions
    computeWireFlowSpecs();
  } else if (sc instanceof Button) {
    sc.pressed = !!comp.closed;
  }
}

// ─── Per-wire current via DFS + KCL ────────────────────────────────────────
// Each wire's current depends on the topology around it. We can't read it
// from `comp.current` alone (that's the total through the component). We
// instead build a graph of pins, remove the wire, DFS one side, and apply
// KCL: outflow_via_components + outflow_via_wires_crossing_cut = 0.

const GND_KEY = '__GROUND__';

/** Polarity of a 2-terminal component (positive pin → entry pin).
 * For SPDT Switch (3 pins), the active channel depends on `closed`:
 * com↔a when open, com↔b when closed. */
function getComponentPolarity(comp: PlacedComponent): { pos: string; neg: string } | null {
  if (comp.type === 'Switch') {
    return comp.closed ? { pos: 'com', neg: 'b' } : { pos: 'com', neg: 'a' };
  }
  if (comp.pins.length !== 2) return null;
  const names = comp.pins.map(p => p.name);
  if (names.includes('1') && names.includes('2')) return { pos: '1', neg: '2' };
  if (names.includes('+') && names.includes('-')) return { pos: '+', neg: '-' };
  if (names.includes('anode') && names.includes('cathode')) return { pos: 'anode', neg: 'cathode' };
  return null;
}

/** Vertex key for a (component, pin) pair. Ground pins all collapse to GND_KEY. */
function pinKeyOf(comp: PlacedComponent, pinName: string): string {
  if (comp.type === 'Ground') return GND_KEY;
  return `${comp.id}:${pinName}`;
}

function computeWireFlowSpecs(): void {
  wireFlowSpecs = new Map();
  if (wires.length === 0) return;

  const compById = new Map<string, PlacedComponent>();
  for (const c of components) compById.set(c.id, c);

  // Union-Find to cluster pins into electrical nodes (pins joined by wires
  // and Ground markers belong to the same node).
  const ufParent = new Map<string, string>();
  const ufFind = (x: string): string => {
    let p = ufParent.get(x);
    if (p === undefined) { ufParent.set(x, x); return x; }
    if (p === x) return x;
    const r = ufFind(p);
    ufParent.set(x, r);
    return r;
  };
  const ufUnion = (a: string, b: string) => {
    const ra = ufFind(a), rb = ufFind(b);
    if (ra !== rb) ufParent.set(ra, rb);
  };

  // Pre-register every pin as its own node (Ground pins all become GND_KEY)
  for (const c of components) {
    if (c.type === 'Ground') {
      ufUnion(pinKeyOf(c, c.pins[0].name), GND_KEY);
    } else {
      for (const p of c.pins) ufFind(pinKeyOf(c, p.name));
    }
  }
  ufFind(GND_KEY);

  // Wires merge their two pins into the same node
  for (const wire of wires) {
    const f = wire.from as { componentId: string; pinName: string };
    const t = wire.to as { componentId: string; pinName: string };
    const fc = compById.get(f.componentId);
    const tc = compById.get(t.componentId);
    if (!fc || !tc) continue;
    ufUnion(pinKeyOf(fc, f.pinName), pinKeyOf(tc, t.pinName));
  }
  // Legacy ground markers
  for (const g of grounds) {
    const c = compById.get(g.componentId);
    if (c) ufUnion(pinKeyOf(c, g.pinName), GND_KEY);
  }

  // For each wire, build a *local* adjacency restricted to the wire's node
  // (only wires whose two endpoints are in the same node). DFS in that
  // subgraph without W: components and other nodes are NOT traversed, so
  // removing W can actually disconnect part of the node — that's the cut.
  for (const wire of wires) {
    const f = wire.from as { componentId: string; pinName: string };
    const t = wire.to as { componentId: string; pinName: string };
    const fc = compById.get(f.componentId);
    const tc = compById.get(t.componentId);
    if (!fc || !tc) {
      wireFlowSpecs.set(wire.id, { contribs: [], divisor: 1 });
      continue;
    }
    const startKey = pinKeyOf(fc, f.pinName);
    const goalKey = pinKeyOf(tc, t.pinName);
    const nodeId = ufFind(startKey);

    // Build local adjacency (this node only)
    const localAdj = new Map<string, { other: string; wireId: string }[]>();
    const addLocal = (a: string, b: string, wId: string) => {
      if (!localAdj.has(a)) localAdj.set(a, []);
      if (!localAdj.has(b)) localAdj.set(b, []);
      localAdj.get(a)!.push({ other: b, wireId: wId });
      localAdj.get(b)!.push({ other: a, wireId: wId });
    };
    for (const w of wires) {
      const wf = w.from as { componentId: string; pinName: string };
      const wt = w.to as { componentId: string; pinName: string };
      const wfc = compById.get(wf.componentId);
      const wtc = compById.get(wt.componentId);
      if (!wfc || !wtc) continue;
      const a = pinKeyOf(wfc, wf.pinName);
      const b = pinKeyOf(wtc, wt.pinName);
      if (ufFind(a) !== nodeId) continue;
      addLocal(a, b, w.id);
    }

    // DFS skipping W
    const visited = new Set<string>();
    const stack = [startKey];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const edges = localAdj.get(cur);
      if (!edges) continue;
      for (const e of edges) {
        if (e.wireId === wire.id) continue;
        if (!visited.has(e.other)) stack.push(e.other);
      }
    }

    // Multi-bridge inside this node — current undetermined topologically
    if (visited.has(goalKey)) {
      wireFlowSpecs.set(wire.id, { contribs: [], divisor: 1 });
      continue;
    }

    // Component contributions: a component touches S via one pin if that
    // pin's key is in `visited`. The other pin is in a different node, so
    // it's never in `visited`. Sign: +1 if posPin is in S, -1 if negPin.
    const contribs: WireContribution[] = [];
    for (const comp of components) {
      const pol = getComponentPolarity(comp);
      if (!pol) continue;
      const posIn = visited.has(pinKeyOf(comp, pol.pos));
      const negIn = visited.has(pinKeyOf(comp, pol.neg));
      if (posIn && !negIn) contribs.push({ componentId: comp.id, sign: +1 });
      else if (negIn && !posIn) contribs.push({ componentId: comp.id, sign: -1 });
    }

    // Divisor: this wire + any other local wires that also cross S↔(node\S)
    let divisor = 1;
    for (const w of wires) {
      if (w.id === wire.id) continue;
      const wf = w.from as { componentId: string; pinName: string };
      const wt = w.to as { componentId: string; pinName: string };
      const wfc = compById.get(wf.componentId);
      const wtc = compById.get(wt.componentId);
      if (!wfc || !wtc) continue;
      const a = pinKeyOf(wfc, wf.pinName);
      const b = pinKeyOf(wtc, wt.pinName);
      if (ufFind(a) !== nodeId) continue;
      if (visited.has(a) !== visited.has(b)) divisor++;
    }

    wireFlowSpecs.set(wire.id, { contribs, divisor });
  }
}

/** Hit-test a (world) point against existing wires using their cached A* paths.
 * Returns the wire id, hit point and segment orientation within `tol` pixels. */
function hitTestWire(
  worldX: number, worldY: number, tol = 6,
): { wireId: string; index: number; px: number; py: number; orientation: 'h' | 'v' } | null {
  if (pathsCache.length !== wires.length) return null;
  let best: { wireId: string; index: number; px: number; py: number; d2: number; orientation: 'h' | 'v' } | null = null;
  const tol2 = tol * tol;
  for (let i = 0; i < wires.length; i++) {
    const path = pathsCache[i];
    if (!path || path.length < 2) continue;
    for (let j = 1; j < path.length; j++) {
      const a = path[j - 1], b = path[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((worldX - a.x) * dx + (worldY - a.y) * dy) / len2));
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const d2 = (worldX - px) * (worldX - px) + (worldY - py) * (worldY - py);
      if (d2 <= tol2 && (!best || d2 < best.d2)) {
        const orientation: 'h' | 'v' = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        best = { wireId: wires[i].id, index: i, px, py, d2, orientation };
      }
    }
  }
  if (!best) return null;
  return { wireId: best.wireId, index: best.index, px: best.px, py: best.py, orientation: best.orientation };
}

/** Compute the current flowing through `wire` in its from→to direction. */
function wireCurrentFor(wire: Wire): number {
  const spec = wireFlowSpecs.get(wire.id);
  if (!spec || spec.contribs.length === 0) return 0;
  let sum = 0;
  for (const c of spec.contribs) {
    const comp = components.find(cc => cc.id === c.componentId);
    if (comp) sum += c.sign * (comp.current ?? 0);
  }
  // KCL: outflow_via_wires = -outflow_via_components
  // For this wire (from→to is "leaving S_from"): I = -sum / divisor
  return -sum / spec.divisor;
}

// ─── Continuous simulation (Play / Pause) ──────────────────────────────────

const SIM_FIXED_DT = 1e-5;            // 10µs default timestep
const SIM_MAX_STEPS_PER_FRAME = 600;  // cap so a single frame can't stall

function isSimulating(): boolean {
  return simSession !== null;
}

function togglePlay() {
  if (isSimulating()) pauseSimulation();
  else startSimulation();
}

function setPlayButton(playing: boolean): void {
  const icon = document.getElementById('btn-play-icon')!;
  const label = document.getElementById('btn-play-label')!;
  if (playing) {
    icon.innerHTML = '<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>';
    label.textContent = 'Pause';
  } else {
    icon.innerHTML = '<path d="M5 4l14 8-14 8V4z" fill="currentColor"/>';
    label.textContent = 'Play';
  }
}

function startSimulation(): void {
  if (components.length === 0) {
    statusText.textContent = 'Nenhum componente no circuito';
    return;
  }
  if (!hasAnyGround()) {
    statusText.textContent = 'Adicione pelo menos um GND';
    return;
  }

  try {
    const { circuit, simComponents } = buildCircuit();
    const specs: ProbeSpec[] = probes.map(probe => ({
      label: probe.label,
      color: probe.color,
      component: simComponents.get(probe.componentId)!,
      type: probe.type,
    }));

    simSession = new TransientSession(circuit, specs);
    simSimComponents = simComponents;
    simProbeLabels = probes.map(p => ({ label: p.label, color: p.color }));
    simLastWallTime = performance.now();
    simChartLastUpdate = 0;
    showResults = true;
    setPlayButton(true);
    statusText.textContent = 'Simulando…';

    simulationLoop();
  } catch (error) {
    statusText.textContent = `Erro: ${error instanceof Error ? error.message : String(error)}`;
    simSession = null;
    simSimComponents = null;
  }
}

function pauseSimulation(): void {
  if (simAnimFrame !== null) {
    cancelAnimationFrame(simAnimFrame);
    simAnimFrame = null;
  }
  if (simSession) {
    simSession.end();
    simSession = null;
  }
  simSimComponents = null;
  setPlayButton(false);
  statusText.textContent = 'Pausado';
  render();
}

function stopSimulation(): void {
  pauseSimulation();
  transientResult = null;
}

/** Stop the running simulation when the user mutates the circuit. */
function invalidateSimulation(): void {
  if (isSimulating()) pauseSimulation();
}

/** Mark the circuit as dirty: clears stale results and pauses live sim. */
function invalidate(): void {
  showResults = false;
  invalidateSimulation();
}

function simulationLoop(): void {
  if (!simSession || !simSimComponents) return;
  const now = performance.now();
  const wallDt = Math.min(0.05, (now - simLastWallTime) / 1000); // cap 50ms
  simLastWallTime = now;

  const simBudget = wallDt * timeScale;
  let dt = SIM_FIXED_DT;
  let nSteps = Math.ceil(simBudget / dt);
  if (nSteps > SIM_MAX_STEPS_PER_FRAME) {
    nSteps = SIM_MAX_STEPS_PER_FRAME;
    dt = simBudget / nSteps;
  }
  if (nSteps < 1) nSteps = 1;

  try {
    for (let i = 0; i < nSteps; i++) simSession.step(dt);
  } catch (error) {
    statusText.textContent = `Erro na simulacao: ${error instanceof Error ? error.message : String(error)}`;
    pauseSimulation();
    return;
  }

  // Mirror live V/I onto the placed components
  for (const comp of components) {
    const sc = simSimComponents.get(comp.id);
    if (sc) {
      comp.voltage = sc.voltage;
      comp.current = sc.current;
    }
  }

  // Throttle chart/scope updates to ~12 Hz
  if (simProbeLabels.length > 0 && now - simChartLastUpdate > 80) {
    simChartLastUpdate = now;
    transientResult = {
      timePoints: [...simSession.timePoints],
      probes: simSession.probeValues.map((vals, i) => ({
        label: simProbeLabels[i].label,
        color: simProbeLabels[i].color,
        values: [...vals],
      })),
    };
    const waveforms: WaveformData[] = transientResult.probes.map(p => ({
      label: p.label, color: p.color, values: p.values, timePoints: transientResult!.timePoints,
    }));
    const primaryUnit = probes[0]?.type === 'current' ? 'A' : 'V';
    showScopeOverlay(waveforms, primaryUnit);
    renderChart();
  }

  updateResults();
  render();

  simAnimFrame = requestAnimationFrame(simulationLoop);
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

function renderChart() {
  if (!transientResult) return;
  const waveforms: WaveformData[] = transientResult.probes.map(p => ({
    label: p.label,
    color: p.color,
    values: p.values,
    timePoints: transientResult!.timePoints,
  }));
  drawChart(chartCtx, chartCanvas.width, chartCanvas.height, waveforms);
}

// ─── Tab switching ───────────────────────────────────────────────────────────

function switchTab(tabName: string) {
  bottomPanel.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', (t as HTMLElement).dataset.tab === tabName);
  });
  bottomPanel.querySelectorAll('.tab-content').forEach(tc => {
    tc.classList.toggle('active', (tc as HTMLElement).dataset.tab === tabName);
  });
  if (tabName === 'chart') {
    setTimeout(() => {
      const chartContent = document.getElementById('chart-content')!;
      chartCanvas.width = chartContent.clientWidth;
      chartCanvas.height = chartContent.clientHeight;
      renderChart();
    }, 0);
  }
}

bottomPanel.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchTab((tab as HTMLElement).dataset.tab!);
  });
});

// ─── Code execution ──────────────────────────────────────────────────────────

interface TrackedComponent {
  instance: Component;
  type: ComponentType;
  value: number;
  label: string;
  varName: string;
  customDef?: ComponentDef;
}

interface TrackedConnection {
  fromInstance: Component;
  fromPin: string;
  toInstance: Component;
  toPin: string;
}

interface TrackedGround {
  instance: Component;
  pinName: string;
}

function executeUserCode(code: string) {
  consoleOutput.innerHTML = '';
  const tracked: TrackedComponent[] = [];
  const connections: TrackedConnection[] = [];
  const trackedGrounds: TrackedGround[] = [];
  const trackedProbes: { instance: Component; type: 'voltage' | 'current'; label: string; color: string }[] = [];
  const state = { transientResult: null as TransientResult | null };
  let compCounter: Record<string, number> = {};

  // Custom console
  const customConsole = {
    log: (...args: unknown[]) => {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      consoleOutput.appendChild(line);
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    },
    error: (...args: unknown[]) => {
      const line = document.createElement('div');
      line.className = 'error-line';
      line.textContent = args.map(a => String(a)).join(' ');
      consoleOutput.appendChild(line);
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    },
    warn: (...args: unknown[]) => {
      const line = document.createElement('div');
      line.className = 'warn-line';
      line.textContent = args.map(a => String(a)).join(' ');
      consoleOutput.appendChild(line);
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
    },
  };

  // Resolve the real instance behind a proxy
  function resolveInstance(obj: any): Component | null {
    if (obj && obj._isComponentProxy) return obj._target;
    if (obj instanceof Component) return obj;
    return null;
  }

  // Pin proxy that intercepts .connect()
  let groundPin: any = null;

  function makePinProxy(instance: Component, pinName: string) {
    const realPin = instance.pin(pinName);
    return {
      connect(other: any) {
        // Connecting to ground pin directly
        if (other === groundPin) {
          trackedGrounds.push({ instance, pinName });
          realPin.connect(other);
        }
        // Connecting to a Ground component proxy
        else if (other && other._isGroundProxy) {
          trackedGrounds.push({ instance, pinName });
          realPin.connect(groundPin);
        }
        // Connecting to another component's pin proxy
        else if (other && other._isProxy) {
          // Check if the other side is a Ground component
          if (other._isGroundPin) {
            trackedGrounds.push({ instance, pinName });
            realPin.connect(groundPin);
          } else {
            connections.push({
              fromInstance: instance, fromPin: pinName,
              toInstance: other._instance, toPin: other._pinName,
            });
            realPin.connect(other._realPin);
          }
        } else {
          realPin.connect(other);
        }
        return this;
      },
      _isProxy: true,
      _isGroundPin: false,
      _instance: instance,
      _pinName: pinName,
      _realPin: realPin,
    };
  }

  // Wrapped Circuit with probe() and Ground support
  function WrappedCircuit() {
    const circuit = new Circuit();
    groundPin = circuit.ground;

    return {
      ground: groundPin,
      probe(comp: any, type: 'voltage' | 'current' = 'voltage', label?: string, color?: string) {
        const inst = resolveInstance(comp);
        if (!inst) throw new Error('probe() requires a component');
        const t = tracked.find(t => t.instance === inst);
        const autoLabel = label ?? `${type === 'voltage' ? 'V' : 'I'}(${t?.label ?? '?'})`;
        const autoColor = color ?? PROBE_COLORS[trackedProbes.length % PROBE_COLORS.length];
        trackedProbes.push({ instance: inst as Component, type, label: autoLabel, color: autoColor });
      },
      analyze: (type: string, config?: any) => {
        if (type === 'transient') {
          if (trackedProbes.length === 0) {
            throw new Error('Adicione pelo menos uma probe antes de analyze("transient")');
          }
          const specs: ProbeSpec[] = trackedProbes.map(p => ({
            label: p.label,
            color: p.color,
            component: p.instance,
            type: p.type,
          }));
          const result = circuit.analyze('transient', config, specs);
          state.transientResult = result;
          return result;
        }
        return circuit.analyze('dc');
      },
    };
  }

  // Component wrapper factory
  function makeTrackedWrapper(CompClass: any, type: ComponentType, prefix: string) {
    return function (...args: any[]) {
      const instance = new CompClass(...args);
      compCounter[type] = (compCounter[type] || 0) + 1;
      const num = compCounter[type];
      const label = `${prefix}${num}`;
      tracked.push({ instance, type, value: args[0] ?? 0, label, varName: `${prefix.toLowerCase()}${num}` });

      const proxy = new Proxy(instance, {
        get(target, prop) {
          if (prop === '_isComponentProxy') return true;
          if (prop === '_target') return target;
          if (prop === 'pin') {
            return (name: string) => makePinProxy(target, name);
          }
          if (prop === 'voltage') return target.voltage;
          if (prop === 'current') return target.current;
          const val = (target as any)[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
      return proxy;
    };
  }

  // Ground component wrapper — connects anything to circuit.ground
  function GroundWrapper() {
    return {
      _isGroundProxy: true,
      pin(_name: string) {
        return {
          _isProxy: true,
          _isGroundPin: true,
          _instance: null,
          _pinName: 'gnd',
          _realPin: groundPin,
          connect(other: any) {
            if (other && other._isProxy && other._instance) {
              trackedGrounds.push({ instance: other._instance, pinName: other._pinName });
              other._realPin.connect(groundPin);
            }
            return this;
          },
        };
      },
    };
  }

  // Junction wrapper — collapses every pin connected through it into one node.
  // Uses a no-op placeholder Component so we have a real Pin object to expose
  // as `_realPin`; this guarantees `Pin.connect(other.node)` never trips.
  class JunctionPlaceholder extends Component {
    private _pinObj: import('../core/Pin').Pin;
    constructor() {
      super();
      this._pinObj = (this as any).addPin('j');
    }
    stamp(): void { /* no-op: junction is just a node */ }
    getPin(): import('../core/Pin').Pin { return this._pinObj; }
  }
  function JunctionWrapper() {
    const placeholder = new JunctionPlaceholder();
    const junctionPin = placeholder.getPin();
    return {
      _isJunctionProxy: true,
      pin(_name: string) {
        return {
          _isProxy: true,
          _isJunctionPin: true,
          _instance: placeholder,
          _pinName: 'j',
          _realPin: junctionPin,
          connect(other: any) {
            if (other && other._realPin) {
              junctionPin.connect(other._realPin);
            } else if (other && typeof other.connect === 'function' && other.node) {
              junctionPin.connect(other);
            }
            return this;
          },
        };
      },
    };
  }

  // Wrapped defineComponent that registers custom components and returns tracked wrappers
  function wrappedDefineComponent(def: ComponentDef) {
    const CompClass = realDefineComponent(def);

    // Register in UI custom component registry
    const pinDefs: PinDef[] = def.pins.map(name => {
      const layout = def.pinLayout?.[name];
      return {
        name,
        offset: layout ? { x: layout.dx, y: layout.dy } : { x: 0, y: 0 },
      };
    });

    // Auto-generate pin layout if not provided
    if (!def.pinLayout && def.pins.length >= 2) {
      const count = def.pins.length;
      // 2 pins: horizontal like resistor
      if (count === 2) {
        pinDefs[0].offset = { x: -40, y: 0 };
        pinDefs[1].offset = { x: 40, y: 0 };
      } else {
        // Multi-pin: left side inputs, right side outputs
        const leftCount = Math.ceil(count / 2);
        const rightCount = count - leftCount;
        for (let i = 0; i < leftCount; i++) {
          const ySpacing = 30;
          const yOffset = -(leftCount - 1) * ySpacing / 2 + i * ySpacing;
          pinDefs[i].offset = { x: -40, y: yOffset };
        }
        for (let i = 0; i < rightCount; i++) {
          const ySpacing = 30;
          const yOffset = -(rightCount - 1) * ySpacing / 2 + i * ySpacing;
          pinDefs[leftCount + i].offset = { x: 40, y: yOffset };
        }
      }
    }

    const firstParam = def.params ? Object.values(def.params)[0] : undefined;
    customComponentDefs.set(def.name, {
      defaultValue: firstParam?.default ?? 0,
      unit: firstParam?.unit ?? '',
      label: def.label ?? def.name.substring(0, 3),
      pins: pinDefs,
      draw: def.draw,
    });

    // Return a tracked wrapper constructor
    const prefix = def.label ?? def.name.substring(0, 3);
    return function (params?: Record<string, number>) {
      const instance = new CompClass(params);
      compCounter[def.name] = (compCounter[def.name] || 0) + 1;
      const num = compCounter[def.name];
      const label = `${prefix}${num}`;
      const value = params ? Object.values(params)[0] ?? 0 : 0;
      tracked.push({
        instance, type: def.name, value, label,
        varName: `${prefix.toLowerCase().replace(/[^a-z0-9]/g, '')}${num}`,
        customDef: def,
      });

      const proxy = new Proxy(instance, {
        get(target, prop) {
          if (prop === '_isComponentProxy') return true;
          if (prop === '_target') return target;
          if (prop === 'pin') {
            return (name: string) => makePinProxy(target, name);
          }
          const val = (target as any)[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
      return proxy;
    };
  }

  try {
    const fn = new Function(
      'Circuit', 'Resistor', 'VoltageSource', 'CurrentSource',
      'Capacitor', 'Inductor', 'Diode', 'LED', 'Ground', 'Junction',
      'Switch', 'Button',
      'defineComponent', 'console',
      code
    );

    fn(
      WrappedCircuit,
      makeTrackedWrapper(Resistor, 'Resistor', 'R'),
      makeTrackedWrapper(VoltageSource, 'VoltageSource', 'V'),
      makeTrackedWrapper(CurrentSource, 'CurrentSource', 'I'),
      makeTrackedWrapper(Capacitor, 'Capacitor', 'C'),
      makeTrackedWrapper(Inductor, 'Inductor', 'L'),
      makeTrackedWrapper(Diode, 'Diode', 'D'),
      makeTrackedWrapper(LED, 'LED', 'LED'),
      GroundWrapper,
      JunctionWrapper,
      makeTrackedWrapper(Switch, 'Switch', 'SW'),
      makeTrackedWrapper(Button, 'Button', 'BT'),
      wrappedDefineComponent,
      customConsole,
    );

    // Convert tracked data to visual components
    if (tracked.length > 0) {
      syncTrackedToCanvas(tracked, connections, trackedGrounds, trackedProbes);
    }

    // If transient was run from code, show chart
    if (state.transientResult) {
      transientResult = state.transientResult;
      switchTab('chart');
      resize();
      statusText.textContent = `Codigo executado: ${tracked.length} componentes, transiente ${state.transientResult.timePoints.length} pontos`;
    } else {
      statusText.textContent = `Codigo executado: ${tracked.length} componentes`;
    }
  } catch (err) {
    customConsole.error(String(err));
    statusText.textContent = 'Erro na execucao do codigo';
  }
}

// ─── Auto-layout ─────────────────────────────────────────────────────────────

function syncTrackedToCanvas(
  tracked: TrackedComponent[],
  connections: TrackedConnection[],
  trackedGrounds: TrackedGround[],
  trackedProbes: { instance: Component; type: 'voltage' | 'current'; label: string; color: string }[] = [],
) {
  // Snapshot existing positions so the user's manual layout survives a re-run.
  // Key by `${type}:${label}` for normal components. For Ground components,
  // key by the anchor pin reachable through a single wire.
  const savedPositions = new Map<string, { x: number; y: number; rotation: number }>();
  const savedGroundPositions = new Map<string, { x: number; y: number; rotation: number }>();
  for (const c of components) {
    if (c.type === 'Ground') {
      const w = wires.find(w => {
        const f = w.from as { componentId: string };
        const t = w.to as { componentId: string };
        return f.componentId === c.id || t.componentId === c.id;
      });
      if (w) {
        const f = w.from as { componentId: string; pinName: string };
        const t = w.to as { componentId: string; pinName: string };
        const anchorRef = f.componentId === c.id ? t : f;
        const anchor = components.find(cc => cc.id === anchorRef.componentId);
        if (anchor) {
          savedGroundPositions.set(`${anchor.type}:${anchor.label}:${anchorRef.pinName}`, {
            x: c.x, y: c.y, rotation: c.rotation,
          });
        }
      }
    } else {
      savedPositions.set(`${c.type}:${c.label}`, { x: c.x, y: c.y, rotation: c.rotation });
    }
  }

  // Clear existing
  invalidateSimulation();
  components = [];
  wires = [];
  grounds = [];
  probes = [];
  selectedId = null;
  showResults = false;

  const instanceToId = new Map<Component, string>();
  const ORIGIN_X = 180;
  const ORIGIN_Y = 160;
  const SPACING_X = 160;
  const SPACING_Y = 120;
  const MAX_PER_COL = 4;

  // Separate sources (left column) from passive/other (right columns)
  const sources = tracked.filter(t => t.type === 'VoltageSource' || t.type === 'CurrentSource');
  const others = tracked.filter(t => t.type !== 'VoltageSource' && t.type !== 'CurrentSource');

  // Place sources vertically in left column
  sources.forEach((t, i) => {
    const def = getComponentDef(t.type);
    const pins = def ? [...def.pins] : t.instance.allPins().map(p => ({ name: p.name, offset: { x: 0, y: 0 } }));
    const saved = savedPositions.get(`${t.type}:${t.label}`);
    const comp: PlacedComponent = {
      id: `c${nextId++}`, type: t.type,
      x: saved?.x ?? ORIGIN_X,
      y: saved?.y ?? ORIGIN_Y + i * SPACING_Y,
      rotation: saved?.rotation ?? 0,
      value: t.value,
      label: t.label, pins,
    };
    if (t.type === 'VoltageSource' && t.instance instanceof VoltageSource) {
      comp.acAmplitude = t.instance.acAmplitude;
      comp.frequency = t.instance.frequency;
    }
    components.push(comp);
    instanceToId.set(t.instance, comp.id);
  });

  // Place others in columns to the right
  others.forEach((t, i) => {
    const col = Math.floor(i / MAX_PER_COL);
    const row = i % MAX_PER_COL;
    const def = getComponentDef(t.type);
    const pins = def ? [...def.pins] : t.instance.allPins().map(p => ({ name: p.name, offset: { x: 0, y: 0 } }));
    const saved = savedPositions.get(`${t.type}:${t.label}`);
    const comp: PlacedComponent = {
      id: `c${nextId++}`, type: t.type,
      x: saved?.x ?? ORIGIN_X + SPACING_X * (col + 1),
      y: saved?.y ?? ORIGIN_Y + row * SPACING_Y,
      rotation: saved?.rotation ?? 0,
      value: t.value,
      label: t.label, pins,
    };
    components.push(comp);
    instanceToId.set(t.instance, comp.id);
  });

  // Convert connections to wires
  for (const conn of connections) {
    const fromId = instanceToId.get(conn.fromInstance);
    const toId = instanceToId.get(conn.toInstance);
    if (fromId && toId) {
      wires.push({
        id: `w${nextId++}`,
        from: { componentId: fromId, pinName: conn.fromPin },
        to: { componentId: toId, pinName: conn.toPin },
      });
    }
  }

  // Convert grounds: each tracked ground becomes a Ground component placed
  // below its anchor component (or at its previous position if it existed),
  // connected by a short wire.
  for (const g of trackedGrounds) {
    const anchorId = instanceToId.get(g.instance);
    if (!anchorId) continue;
    const anchor = components.find(c => c.id === anchorId);
    if (!anchor) continue;

    const savedGnd = savedGroundPositions.get(`${anchor.type}:${anchor.label}:${g.pinName}`);
    const gndComp: PlacedComponent = {
      id: `c${nextId++}`, type: 'Ground',
      x: savedGnd?.x ?? anchor.x,
      y: savedGnd?.y ?? anchor.y + 80,
      rotation: savedGnd?.rotation ?? 0,
      value: 0, label: '',
      pins: [...COMPONENT_DEFS.Ground.pins],
    };
    components.push(gndComp);

    wires.push({
      id: `w${nextId++}`,
      from: { componentId: anchorId, pinName: g.pinName },
      to: { componentId: gndComp.id, pinName: '1' },
    });
  }

  // Convert probes
  for (const p of trackedProbes) {
    const compId = instanceToId.get(p.instance);
    if (compId) {
      const comp = components.find(c => c.id === compId)!;
      const pinName = comp.pins[0].name; // probe on first pin
      probes.push({
        id: `p${nextId++}`,
        componentId: compId,
        pinName,
        type: p.type,
        color: p.color,
        label: p.label,
      });
    }
  }

  updateProps();
  updateResults();
  render();
}

// ─── Code generation ─────────────────────────────────────────────────────────

function generateCode(): string {
  const groundCompIds = new Set(components.filter(c => c.type === 'Ground').map(c => c.id));
  const junctionCompIds = new Set(components.filter(c => c.type === 'Junction').map(c => c.id));
  const hasGrounds = groundCompIds.size > 0 || grounds.length > 0;

  const lines: string[] = ['const circuit = new Circuit();'];
  if (hasGrounds) lines.push('const gnd = new Ground();');
  lines.push('');

  // Declare real components only (skip Ground / Junction — they are nodes, not objects)
  const idToVar = new Map<string, string>();
  const usedNames = new Map<string, number>();
  for (const comp of components) {
    if (groundCompIds.has(comp.id) || junctionCompIds.has(comp.id)) continue;
    let varName = comp.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!varName) {
      const prefix = comp.type.toLowerCase().slice(0, 3);
      const n = (usedNames.get(prefix) ?? 0) + 1;
      usedNames.set(prefix, n);
      varName = `${prefix}${n}`;
    }
    idToVar.set(comp.id, varName);

    const def = getComponentDef(comp.type);
    if (def?.unit) {
      lines.push(`const ${varName} = new ${comp.type}(${comp.value});`);
    } else {
      lines.push(`const ${varName} = new ${comp.type}();`);
    }

    // AC params for voltage sources
    if (comp.type === 'VoltageSource' && (comp.acAmplitude || comp.frequency)) {
      if (comp.acAmplitude) lines.push(`${varName}.acAmplitude = ${comp.acAmplitude};`);
      if (comp.frequency) lines.push(`${varName}.frequency = ${comp.frequency};`);
    }
  }

  lines.push('');

  // Cluster pins into electrical nodes (same approach as buildCircuit). Junctions
  // and Grounds are passthroughs — multiple wires sharing them collapse into the
  // same cluster and emit a single set of `.connect()` calls.
  const ufParent = new Map<string, string>();
  const ufFind = (x: string): string => {
    let p = ufParent.get(x);
    if (p === undefined) { ufParent.set(x, x); return x; }
    if (p === x) return x;
    const r = ufFind(p);
    ufParent.set(x, r);
    return r;
  };
  const ufUnion = (a: string, b: string) => {
    const ra = ufFind(a), rb = ufFind(b);
    if (ra !== rb) ufParent.set(ra, rb);
  };
  const GROUND_ROOT = '__GROUND_CLUSTER__';
  ufFind(GROUND_ROOT);
  for (const c of components) {
    if (c.type === 'Ground') ufUnion(`${c.id}:1`, GROUND_ROOT);
  }
  for (const wire of wires) {
    const f = wire.from as { componentId: string; pinName: string };
    const t = wire.to as { componentId: string; pinName: string };
    ufUnion(`${f.componentId}:${f.pinName}`, `${t.componentId}:${t.pinName}`);
  }
  for (const g of grounds) {
    ufUnion(`${g.componentId}:${g.pinName}`, GROUND_ROOT);
  }

  // Group real-component pins by cluster
  const clusterPins = new Map<string, { compId: string; pinName: string }[]>();
  for (const c of components) {
    if (!idToVar.has(c.id)) continue; // skip ground/junction/custom
    for (const pin of c.pins) {
      const root = ufFind(`${c.id}:${pin.name}`);
      if (!clusterPins.has(root)) clusterPins.set(root, []);
      clusterPins.get(root)!.push({ compId: c.id, pinName: pin.name });
    }
  }

  const groundRoot = ufFind(GROUND_ROOT);
  for (const [root, pins] of clusterPins) {
    if (root === groundRoot) {
      for (const p of pins) {
        const v = idToVar.get(p.compId);
        if (v) lines.push(`${v}.pin('${p.pinName}').connect(gnd.pin('1'));`);
      }
    } else if (pins.length >= 2) {
      const head = pins[0];
      const headVar = idToVar.get(head.compId);
      if (!headVar) continue;
      for (let i = 1; i < pins.length; i++) {
        const p = pins[i];
        const v = idToVar.get(p.compId);
        if (v) lines.push(`${headVar}.pin('${head.pinName}').connect(${v}.pin('${p.pinName}'));`);
      }
    }
  }

  // Probes → circuit.probe()
  if (probes.length > 0) {
    lines.push('');
    for (const probe of probes) {
      const varName = idToVar.get(probe.componentId);
      if (varName) {
        lines.push(`circuit.probe(${varName}, '${probe.type}');`);
      }
    }
  }

  lines.push('');

  if (probes.length > 0) {
    // If there are probes, generate transient analysis
    const dt = (document.getElementById('sim-dt') as HTMLInputElement).value;
    const dur = (document.getElementById('sim-duration') as HTMLInputElement).value;
    lines.push(`circuit.analyze('transient', {`);
    lines.push(`  timeStep: ${dt},`);
    lines.push(`  duration: ${dur},`);
    lines.push(`});`);
  } else {
    lines.push("const result = circuit.analyze('dc');");
    // Add console.log for each component
    for (const comp of components) {
      const varName = idToVar.get(comp.id)!;
      const def = getComponentDef(comp.type);
      if (def?.unit) {
        lines.push("console.log('" + comp.label + ":', " + varName + ".voltage.toFixed(3) + 'V', " + varName + ".current.toFixed(6) + 'A');");
      }
    }
  }

  return lines.join('\n');
}

// ─── Button handlers for code panel ─────────────────────────────────────────

document.getElementById('btn-run-code')!.addEventListener('click', () => {
  executeUserCode(editorAPI.getCombinedCode());
});

document.getElementById('btn-gen-code')!.addEventListener('click', () => {
  editorAPI.setActiveContent(generateCode());
  switchTab('editor');
  statusText.textContent = 'Codigo gerado a partir do circuito visual';
});

// Handle Ctrl+Enter in code editor (textarea still exists in DOM)
const codeTextarea = document.getElementById('code-editor') as HTMLTextAreaElement;
codeTextarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    executeUserCode(editorAPI.getCombinedCode());
  }
});

// ─── Demo RLC ────────────────────────────────────────────────────────────────

function loadDemoRLC() {
  // Clear
  invalidateSimulation();
  components = [];
  wires = [];
  grounds = [];
  probes = [];
  selectedId = null;
  showResults = false;
  transientResult = null;

  // V1: 10V step source
  const v1: PlacedComponent = {
    id: `c${nextId++}`, type: 'VoltageSource', x: 160, y: 280, rotation: 0, value: 10,
    label: 'V1', pins: [...COMPONENT_DEFS.VoltageSource.pins],
  };

  // R1: 1 ohm (low for visible oscillation)
  const r1: PlacedComponent = {
    id: `c${nextId++}`, type: 'Resistor', x: 320, y: 180, rotation: 0, value: 1,
    label: 'R1', pins: [...COMPONENT_DEFS.Resistor.pins],
  };

  // L1: 1mH
  const l1: PlacedComponent = {
    id: `c${nextId++}`, type: 'Inductor', x: 480, y: 180, rotation: 0, value: 0.001,
    label: 'L1', pins: [...COMPONENT_DEFS.Inductor.pins],
  };

  // C1: 10uF
  const c1: PlacedComponent = {
    id: `c${nextId++}`, type: 'Capacitor', x: 580, y: 280, rotation: 90, value: 0.00001,
    label: 'C1', pins: [...COMPONENT_DEFS.Capacitor.pins],
  };

  // GND: placed just below V1, pin at y=360-10=350 lines up with V1.- via short wire
  const gnd: PlacedComponent = {
    id: `c${nextId++}`, type: 'Ground', x: 160, y: 360, rotation: 0, value: 0,
    label: '', pins: [...COMPONENT_DEFS.Ground.pins],
  };

  components.push(v1, r1, l1, c1, gnd);

  // Wires: V1+ → R1.1
  wires.push({ id: `w${nextId++}`, from: { componentId: v1.id, pinName: '+' }, to: { componentId: r1.id, pinName: '1' } });
  // R1.2 → L1.1
  wires.push({ id: `w${nextId++}`, from: { componentId: r1.id, pinName: '2' }, to: { componentId: l1.id, pinName: '1' } });
  // L1.2 → C1.1
  wires.push({ id: `w${nextId++}`, from: { componentId: l1.id, pinName: '2' }, to: { componentId: c1.id, pinName: '1' } });
  // C1.2 → V1-
  wires.push({ id: `w${nextId++}`, from: { componentId: c1.id, pinName: '2' }, to: { componentId: v1.id, pinName: '-' } });
  // V1- → GND.1
  wires.push({ id: `w${nextId++}`, from: { componentId: v1.id, pinName: '-' }, to: { componentId: gnd.id, pinName: '1' } });

  // Probe on C1 pin 1 (voltage across capacitor)
  probes.push({
    id: `p${nextId++}`,
    componentId: c1.id,
    pinName: '1',
    type: 'voltage',
    color: PROBE_COLORS[0],
    label: 'V(C1)',
  });

  // Set transient params
  (document.getElementById('sim-dt') as HTMLInputElement).value = '1e-6';
  (document.getElementById('sim-duration') as HTMLInputElement).value = '5e-3';

  statusText.textContent = 'Demo RLC carregado — clique Transiente para simular';
  updateProps();
  resize();
}

// ─── Simulation results ─────────────────────────────────────────────────────

function updateResults() {
  if (!showResults) { resultsDiv.innerHTML = ''; return; }

  let html = '<h2>Resultados</h2>';
  for (const comp of components) {
    if (comp.voltage === undefined) continue;
    html += `
      <div class="result-item">
        <span class="comp-name">${comp.label}</span>
        <span class="value">${comp.voltage.toFixed(3)}V</span>
        <span class="value">${formatValue(comp.current ?? 0, 'A')}</span>
      </div>`;
  }
  resultsDiv.innerHTML = html;
}

// ─── Status ──────────────────────────────────────────────────────────────────

function updateStatus() {
  if (wireStart) {
    const comp = components.find(c => c.id === wireStart!.componentId)!;
    statusText.textContent = `${comp.label}.${wireStart.pinName} → clique em outro pino`;
  } else if (currentTool === 'select') {
    statusText.textContent = 'Arraste para mover | Pino→pino para conectar | R ou clique-direito para rotacionar';
  } else if (currentTool === 'wire') {
    statusText.textContent = 'Clique em um pino para iniciar um fio';
  } else if (currentTool === 'probe') {
    statusText.textContent = 'Clique em um pino para adicionar/remover probe';
  } else {
    statusText.textContent = `Clique no canvas para posicionar ${currentTool}`;
  }
}

// ─── Build connected pins set ────────────────────────────────────────────────

function getConnectedPins(): Set<string> {
  const set = new Set<string>();
  for (const wire of wires) {
    const from = wire.from as { componentId: string; pinName: string };
    const to = wire.to as { componentId: string; pinName: string };
    set.add(`${from.componentId}:${from.pinName}`);
    set.add(`${to.componentId}:${to.pinName}`);
  }
  for (const gnd of grounds) {
    set.add(`${gnd.componentId}:${gnd.pinName}`);
  }
  return set;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function render() {
  const w = canvas.width;
  const h = canvas.height;
  const connectedPins = getConnectedPins();

  // Background (screen space)
  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, w, h);

  // Draw grid in screen space, aligned to world grid
  drawGridPanZoom(ctx, w, h);

  // Apply pan/zoom transform for scene
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // Layer 1: Wires (below everything) — paths are cached and only recomputed
  // when topology/positions change. Flow animation runs every frame using
  // accumulated phase (so a fluctuating current near zero stays smooth).
  const allObstacles = buildComponentObstacles(components);

  // Build a topology hash (also include via constraints so paths recompute on drag)
  const topoHash = wires.map(w => {
    const f = w.from as { componentId: string; pinName: string };
    const t = w.to as { componentId: string; pinName: string };
    const via = w.via ? `~${w.via.axis}${w.via.value}` : '';
    return `${w.id}|${f.componentId}.${f.pinName}>${t.componentId}.${t.pinName}${via}`;
  }).join(';') + '||' + components.map(c => `${c.id}@${c.x},${c.y}r${c.rotation}`).join(',');

  if (topoHash !== pathsCacheHash) {
    pathsCache = [];
    const segs: Segment[] = [];
    const concat = (acc: Point[], piece: Point[]) => {
      if (acc.length === 0) return [...piece];
      // Skip the first point of the new piece if it duplicates the last of acc
      const last = acc[acc.length - 1];
      const first = piece[0];
      const startIdx = (first && first.x === last.x && first.y === last.y) ? 1 : 0;
      for (let i = startIdx; i < piece.length; i++) acc.push(piece[i]);
      return acc;
    };
    for (const wire of wires) {
      const from = wire.from as { componentId: string; pinName: string };
      const to = wire.to as { componentId: string; pinName: string };
      const fromComp = components.find(c => c.id === from.componentId);
      const toComp = components.find(c => c.id === to.componentId);
      if (!fromComp || !toComp) {
        pathsCache.push([]);
        continue;
      }
      const fromPos = getPinWorldPos(fromComp, from.pinName);
      const toPos = getPinWorldPos(toComp, to.pinName);
      let p: Point[];
      if (wire.via) {
        // Build two waypoints so the middle segment is axis-aligned at `value`.
        let mid1: Point, mid2: Point;
        if (wire.via.axis === 'y') {
          // Horizontal middle stretch at y = value
          mid1 = { x: fromPos.x, y: wire.via.value };
          mid2 = { x: toPos.x,   y: wire.via.value };
        } else {
          // Vertical middle stretch at x = value
          mid1 = { x: wire.via.value, y: fromPos.y };
          mid2 = { x: wire.via.value, y: toPos.y   };
        }
        let acc: Point[] = [];
        acc = concat(acc, routeWire(fromPos, mid1, allObstacles, segs));
        acc = concat(acc, routeWire(mid1,    mid2, allObstacles, segs));
        acc = concat(acc, routeWire(mid2,    toPos, allObstacles, segs));
        p = acc;
      } else {
        p = routeWire(fromPos, toPos, allObstacles, segs);
      }
      pathsCache.push(p);
      segs.push(...pathToSegments(p));
    }
    computeWireFlowSpecs();
    pathsCacheHash = topoHash;
  }

  // Per-frame timing for accumulated phase (independent of `animTime`)
  const nowSec = performance.now() / 1000;
  const frameDt = lastRenderTime > 0 ? Math.min(0.1, nowSec - lastRenderTime) : 0;
  lastRenderTime = nowSec;
  const sim = isSimulating();
  // Smooth-current low-pass: ~60 ms time constant — fast enough to react
  // to manual changes, slow enough to avoid jitter on rough transients.
  const smoothAlpha = sim ? 1 - Math.exp(-frameDt / 0.06) : 1;

  const REF_SPEED = 70;          // px/s for the wire with peak current
  const MIN_SPEED = 18;          // px/s floor for non-trivial currents
  const FREEZE_THRESHOLD = 1e-7; // 100 nA — below this, no animation

  // First pass: compute the instant max current and update the envelope.
  // Attack: snap up. Release: ~1.5 s exponential decay so opening a switch
  // doesn't make the now-tiny remaining current look "fast".
  let instantMax = 0;
  if (sim) {
    for (const wire of wires) {
      const v = Math.abs(wireCurrentFor(wire));
      if (v > instantMax) instantMax = v;
    }
    if (instantMax >= circuitMaxEnvelope) {
      circuitMaxEnvelope = instantMax;
    } else {
      const alphaRelease = 1 - Math.exp(-frameDt / 1.5);
      circuitMaxEnvelope += (instantMax - circuitMaxEnvelope) * alphaRelease;
    }
  } else {
    circuitMaxEnvelope = 0;
  }

  for (let i = 0; i < wires.length; i++) {
    const wire = wires[i];
    const from = wire.from as { componentId: string; pinName: string };
    const to = wire.to as { componentId: string; pinName: string };
    const fromComp = components.find(c => c.id === from.componentId);
    const toComp = components.find(c => c.id === to.componentId);
    if (!fromComp || !toComp) continue;
    const path = pathsCache[i];
    if (!path || path.length === 0) continue;

    let flowOffset = 0;
    if (sim) {
      // Real per-wire current (positive = direction from→to)
      const dirFromToTo = wireCurrentFor(wire);
      const magRaw = Math.abs(dirFromToTo);
      const prev = wireSmoothCurrent.get(wire.id) ?? 0;

      // Asymmetric smoothing: snap on/off transitions so a switch opening
      // freezes the dashes immediately rather than coasting to a stop.
      let smoothed: number;
      if (magRaw < FREEZE_THRESHOLD) {
        smoothed = 0; // snap to off
      } else if (Math.abs(prev) < FREEZE_THRESHOLD) {
        smoothed = dirFromToTo; // snap on (was off)
      } else {
        smoothed = prev + (dirFromToTo - prev) * smoothAlpha;
      }
      wireSmoothCurrent.set(wire.id, smoothed);

      // Relative speed: scale by the circuit's envelope max so the busiest
      // wire goes ~REF_SPEED, others slower in proportion. Below threshold
      // the wire freezes regardless.
      const mag = Math.abs(smoothed);
      let speed = 0;
      if (mag >= FREEZE_THRESHOLD && circuitMaxEnvelope > FREEZE_THRESHOLD) {
        const norm = Math.min(1, mag / circuitMaxEnvelope);
        speed = MIN_SPEED + norm * (REF_SPEED - MIN_SPEED);
      }
      const sign = smoothed >= 0 ? 1 : -1;

      let phase = wireFlowPhase.get(wire.id) ?? 0;
      phase += sign * speed * frameDt;
      wireFlowPhase.set(wire.id, phase);
      flowOffset = speed > 0 ? phase : 0;
    }

    drawWirePath(ctx, path, flowOffset, wire.id === selectedWireId);
  }

  // Wire preview (live A*, not cached, since it depends on the moving cursor)
  if (wireStart) {
    const startComp = components.find(c => c.id === wireStart!.componentId)!;
    const previewSegs: Segment[] = [];
    for (const p of pathsCache) previewSegs.push(...pathToSegments(p));
    const path = routeWire(
      getPinWorldPos(startComp, wireStart.pinName),
      mousePos,
      allObstacles,
      previewSegs,
    );
    drawWirePreviewPath(ctx, path);
  }

  // Layer 2: Component background masks (hide wires under components)
  for (const comp of components) {
    drawComponentMask(ctx, comp);
  }

  // Layer 3: Components on top
  for (const comp of components) {
    drawComponent(ctx, comp, comp.id === selectedId, showResults, connectedPins);
  }

  // Layer 4: Ground symbols
  for (const gnd of grounds) {
    const comp = components.find(c => c.id === gnd.componentId);
    if (!comp) continue;
    drawGroundSymbol(ctx, getPinWorldPos(comp, gnd.pinName));
  }

  // Layer 5: Probe markers
  for (const probe of probes) {
    const comp = components.find(c => c.id === probe.componentId);
    if (!comp) continue;
    drawProbeMarker(ctx, getPinWorldPos(comp, probe.pinName), probe.color);
  }

  // Layer 6: Pin hover
  if (hoveredPin) {
    const comp = components.find(c => c.id === hoveredPin!.componentId);
    if (comp) {
      drawPinHighlight(ctx, getPinWorldPos(comp, hoveredPin.pinName));
    }
  }

  ctx.restore();
}

/** Draw grid dots aligned to world grid, accounting for pan/zoom */
function drawGridPanZoom(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const step = GRID_SIZE;
  const dotRadius = Math.max(0.5, 0.8 * zoom);

  // Compute visible world bounds
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  const startX = Math.floor(topLeft.x / step) * step;
  const startY = Math.floor(topLeft.y / step) * step;
  const endX = Math.ceil(bottomRight.x / step) * step;
  const endY = Math.ceil(bottomRight.y / step) * step;

  ctx.fillStyle = '#1e293b';
  for (let wx = startX; wx <= endX; wx += step) {
    for (let wy = startY; wy <= endY; wy += step) {
      const s = worldToScreen(wx, wy);
      ctx.beginPath();
      ctx.arc(s.x, s.y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ─── Debug API ───────────────────────────────────────────────────────────────

(window as any).__circuit = {
  getState: () => ({ components, wires, grounds, probes }),
  addComponent: (type: ComponentType, x: number, y: number, value: number) => {
    const def = COMPONENT_DEFS[type];
    const count = components.filter(c => c.type === type).length + 1;
    const comp: PlacedComponent = {
      id: `c${nextId++}`, type, x, y, rotation: 0, value,
      label: `${def.label}${count}`, pins: [...def.pins],
    };
    components.push(comp);
    selectedId = comp.id;
    showResults = false;
    updateProps();
    render();
    return comp.id;
  },
  addWire: (fromId: string, fromPin: string, toId: string, toPin: string) => {
    wires.push({ id: `w${nextId++}`, from: { componentId: fromId, pinName: fromPin }, to: { componentId: toId, pinName: toPin } });
    showResults = false; render();
  },
  addGround: (compId: string, pinName: string) => {
    grounds.push({ id: `g${nextId++}`, componentId: compId, pinName });
    showResults = false; render();
  },
  simulate: togglePlay,
  simulateTransient: togglePlay,
  loadDemo: loadDemoRLC,
  clear: () => {
    components = []; wires = []; grounds = []; probes = [];
    selectedId = null; showResults = false; transientResult = null;
    updateProps(); updateResults(); resize();
  },
  render,
};

// ─── Project Bridge & Manager ────────────────────────────────────────────────

const projectBridge: ProjectBridge = {
  getCanvasState() {
    return {
      components: JSON.parse(JSON.stringify(components)),
      wires: JSON.parse(JSON.stringify(wires)),
      grounds: JSON.parse(JSON.stringify(grounds)),
      probes: JSON.parse(JSON.stringify(probes)),
    };
  },
  setCanvasState(state) {
    components = state.components || [];
    wires = state.wires || [];
    grounds = state.grounds || [];
    probes = state.probes || [];
    // Migrate pins of builtin components to current COMPONENT_DEFS offsets.
    // Old saves of `Ground` had pin offset y=-10; we want y=-25 now.
    for (const c of components) {
      const def = COMPONENT_DEFS[c.type];
      if (def) c.pins = [...def.pins];
    }
    // Switch was 2-pin ('1','2') and is now SPDT ('com','a','b'). Re-map
    // existing wire endpoints so old projects still work: 1→com, 2→b
    // (preserves the "closed = current flows through pin 2" behaviour).
    const switchIds = new Set(components.filter(c => c.type === 'Switch').map(c => c.id));
    for (const w of wires) {
      const f = w.from as { componentId?: string; pinName?: string };
      const t = w.to as { componentId?: string; pinName?: string };
      for (const ref of [f, t]) {
        if (!ref.componentId || !switchIds.has(ref.componentId)) continue;
        if (ref.pinName === '1') ref.pinName = 'com';
        else if (ref.pinName === '2') ref.pinName = 'b';
      }
    }
    selectedId = null;
    showResults = false;
    transientResult = null;
    // Update nextId to avoid collisions
    const allIds = [...components.map(c => c.id), ...wires.map(w => w.id), ...grounds.map(g => g.id), ...probes.map(p => p.id)];
    for (const id of allIds) {
      const num = parseInt(id.replace(/\D/g, ''));
      if (!isNaN(num) && num >= nextId) nextId = num + 1;
    }
    updateProps();
    updateResults();
  },
  getEditorAPI() { return editorAPI; },
  getSettings() {
    return {
      simDt: (document.getElementById('sim-dt') as HTMLInputElement).value,
      simDuration: (document.getElementById('sim-duration') as HTMLInputElement).value,
    };
  },
  setSettings(s) {
    (document.getElementById('sim-dt') as HTMLInputElement).value = s.simDt;
    (document.getElementById('sim-duration') as HTMLInputElement).value = s.simDuration;
  },
  getView() { return { panX, panY, zoom }; },
  setView(v) {
    panX = v.panX; panY = v.panY; zoom = v.zoom;
    zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
  },
  render,
  getProjectName() { return projectName; },
  setProjectName(name) { projectName = name; },
};

initProjectManager(projectBridge);

// ─── Auto-save ──────────────────────────────────────────────────────────────

let autoSaveTimer: number | undefined;

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    const project: ProjectData = {
      version: 1,
      name: projectName,
      files: editorAPI.getFiles(),
      canvas: projectBridge.getCanvasState(),
      settings: projectBridge.getSettings(),
      view: { panX, panY, zoom },
    };
    autoSave(project);
  }, 3000);
}

editorAPI.onDidChange(scheduleAutoSave);

// Auto-save on canvas changes (hook into render)
const originalRender = render;
// Override render isn't practical, so we'll use a MutationObserver-free approach:
// schedule auto-save whenever state-changing operations happen.
// The simplest approach: schedule on mouseup (most canvas changes end with mouseup)
canvas.addEventListener('mouseup', scheduleAutoSave);

window.addEventListener('beforeunload', () => {
  const project: ProjectData = {
    version: 1,
    name: projectName,
    files: editorAPI.getFiles(),
    canvas: projectBridge.getCanvasState(),
    settings: projectBridge.getSettings(),
    view: { panX, panY, zoom },
  };
  autoSave(project);
});

// ─── Restore auto-save or set default ───────────────────────────────────────

const saved = loadAutoSave();
if (saved && saved.files && saved.files.length > 0) {
  projectName = saved.name || 'Sem titulo';
  editorAPI.setFiles(saved.files);
  if (saved.canvas) {
    projectBridge.setCanvasState(saved.canvas);
  }
  if (saved.settings) {
    projectBridge.setSettings(saved.settings);
  }
  if (saved.view) {
    projectBridge.setView(saved.view);
  }
  // Update title
  const h1 = document.querySelector('header h1')!;
  h1.textContent = projectName !== 'Sem titulo' ? `Circuit Forge — ${projectName}` : 'Circuit Forge';
} else {
  // Set default content
  editorAPI.setFiles([{ name: 'main.js', content: DEFAULT_CODE }]);
}

// Initial render
updateStatus();
render();
