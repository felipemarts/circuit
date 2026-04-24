import {
  type PlacedComponent, type Wire, type GroundNode, type ToolType, type ComponentType, type Point,
  type Probe, type PinDef, type ProjectData,
  COMPONENT_DEFS, GRID_SIZE, formatValue, getPinWorldPos, PROBE_COLORS,
  getComponentDef, customComponentDefs,
} from './types';
import {
  drawGrid, drawComponent, drawComponentMask, drawWire, drawWirePreview, drawGroundSymbol,
  drawPinHighlight, drawProbeMarker, hitTestPin, hitTestComponent,
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
import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import { defineComponent as realDefineComponent, CustomComponent } from '../core/CustomComponent';
import type { ComponentDef } from '../core/CustomComponent';
import type { ProbeSpec, TransientResult } from '../analysis/TransientAnalysis';
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
let hoveredPin: { componentId: string; pinName: string } | null = null;
let dragging: { componentId: string; offsetX: number; offsetY: number } | null = null;
let wireStart: { componentId: string; pinName: string } | null = null;
let mousePos: Point = { x: 0, y: 0 };
let showResults = false;
let nextId = 1;
let transientResult: TransientResult | null = null;

// Pan & Zoom state
let panX = 0;
let panY = 0;
let zoom = 1;
let panning: { startX: number; startY: number; panStartX: number; panStartY: number } | null = null;

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

document.getElementById('btn-simulate')!.addEventListener('click', runSimulation);
document.getElementById('btn-transient')!.addEventListener('click', runTransientSimulation);
document.getElementById('btn-demo')!.addEventListener('click', loadDemoRLC);
document.getElementById('btn-clear')!.addEventListener('click', () => {
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
    comp.x = snap(world.x - dragging.offsetX);
    comp.y = snap(world.y - dragging.offsetY);
    render();
    return;
  }

  hoveredPin = null;
  for (const comp of components) {
    const pinName = hitTestPin(comp, world.x, world.y);
    if (pinName) {
      hoveredPin = { componentId: comp.id, pinName };
      break;
    }
  }
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
        dragging = { componentId: comp.id, offsetX: x - comp.x, offsetY: y - comp.y };
        updateProps();
        render();
        return;
      }
    }
    selectedId = null;
    updateProps();
    render();
    return;
  }

  if (currentTool === 'wire') {
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, x, y);
      if (pinName) {
        if (!wireStart) {
          wireStart = { componentId: comp.id, pinName };
          updateStatus();
        } else {
          if (wireStart.componentId !== comp.id || wireStart.pinName !== pinName) {
            wires.push({ id: `w${nextId++}`, from: wireStart, to: { componentId: comp.id, pinName } });
            showResults = false;
          }
          wireStart = null;
          updateStatus();
        }
        render();
        return;
      }
    }
    if (wireStart) {
      wireStart = null;
      updateStatus();
      render();
    }
    return;
  }

  if (currentTool === 'ground') {
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, x, y);
      if (pinName) {
        const existing = grounds.findIndex(g => g.componentId === comp.id && g.pinName === pinName);
        if (existing >= 0) {
          grounds.splice(existing, 1);
        } else {
          grounds.push({ id: `g${nextId++}`, componentId: comp.id, pinName });
        }
        showResults = false;
        render();
        return;
      }
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
    dragging = null;
    return;
  }

  if (wireStart && currentTool === 'select') {
    for (const comp of [...components].reverse()) {
      const pinName = hitTestPin(comp, mousePos.x, mousePos.y);
      if (pinName && (wireStart.componentId !== comp.id || wireStart.pinName !== pinName)) {
        wires.push({ id: `w${nextId++}`, from: wireStart, to: { componentId: comp.id, pinName } });
        showResults = false;
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
      showResults = false;
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
      showResults = false;
      updateProps();
      render();
    }
  }

  if (e.key === 'r' || e.key === 'R') {
    rotateSelected();
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
    label: `${def.label}${count}`, pins: [...def.pins],
  };

  components.push(comp);
  selectedId = comp.id;
  showResults = false;
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
    if (!isNaN(v) && v > 0) { comp.value = v; showResults = false; render(); }
  });
  rotInput?.addEventListener('change', () => {
    comp.rotation = ((parseInt(rotInput.value) || 0) % 360 + 360) % 360;
    showResults = false; render();
  });
  rotBtn?.addEventListener('click', () => {
    comp.rotation = (comp.rotation + 90) % 360;
    rotInput.value = String(comp.rotation);
    showResults = false; render();
  });
  acAmpInput?.addEventListener('change', () => {
    comp.acAmplitude = parseFloat(acAmpInput.value) || 0;
  });
  freqInput?.addEventListener('change', () => {
    comp.frequency = parseFloat(freqInput.value) || 0;
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
    showResults = false;
    updateProps();
    render();
  }
});

// ─── Build circuit helper ────────────────────────────────────────────────────

function buildCircuit() {
  const circuit = new Circuit();
  const simComponents = new Map<string, TwoTerminalComponent>();

  for (const comp of components) {
    let simComp: TwoTerminalComponent;
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
      default: continue; // Skip custom components in visual-only simulation
    }
    simComponents.set(comp.id, simComp!);
  }

  function getSimPin(compId: string, pinName: string) {
    return simComponents.get(compId)!.pin(pinName);
  }

  for (const wire of wires) {
    const from = wire.from as { componentId: string; pinName: string };
    const to = wire.to as { componentId: string; pinName: string };
    getSimPin(from.componentId, from.pinName).connect(getSimPin(to.componentId, to.pinName));
  }

  for (const gnd of grounds) {
    getSimPin(gnd.componentId, gnd.pinName).connect(circuit.ground);
  }

  return { circuit, simComponents };
}

// ─── DC Simulation ──────────────────────────────────────────────────────────

function runSimulation() {
  if (components.length === 0) {
    statusText.textContent = 'Nenhum componente no circuito';
    return;
  }
  if (grounds.length === 0) {
    statusText.textContent = 'Adicione pelo menos um GND';
    return;
  }

  try {
    const { circuit, simComponents } = buildCircuit();

    circuit.analyze('dc');

    for (const comp of components) {
      const simComp = simComponents.get(comp.id)!;
      comp.voltage = simComp.voltage;
      comp.current = simComp.current;
    }

    showResults = true;
    statusText.textContent = 'Simulacao DC concluida';
    updateResults();
    render();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    statusText.textContent = `Erro: ${msg}`;
    showResults = false;
  }
}

// ─── Transient Simulation ────────────────────────────────────────────────────

function runTransientSimulation() {
  if (components.length === 0) {
    statusText.textContent = 'Nenhum componente no circuito';
    return;
  }
  if (grounds.length === 0) {
    statusText.textContent = 'Adicione pelo menos um GND';
    return;
  }
  if (probes.length === 0) {
    statusText.textContent = 'Adicione pelo menos uma probe (clique em um pino com a ferramenta Probe)';
    return;
  }

  const dtInput = document.getElementById('sim-dt') as HTMLInputElement;
  const durationInput = document.getElementById('sim-duration') as HTMLInputElement;
  const dt = parseFloat(dtInput.value);
  const duration = parseFloat(durationInput.value);

  if (isNaN(dt) || dt <= 0 || isNaN(duration) || duration <= 0) {
    statusText.textContent = 'Passo e duracao devem ser positivos';
    return;
  }

  statusText.textContent = 'Simulando transiente...';

  setTimeout(() => {
    try {
      const { circuit, simComponents } = buildCircuit();

      const specs: ProbeSpec[] = probes.map(probe => {
        const simComp = simComponents.get(probe.componentId)!;
        return {
          label: probe.label,
          color: probe.color,
          component: simComp,
          type: probe.type,
        };
      });

      const result = circuit.analyze('transient', { timeStep: dt, duration }, specs);
      transientResult = result;

      // Show the oscilloscope overlay with waveforms + stats (primary unit from first probe)
      const waveforms: WaveformData[] = result.probes.map(p => ({
        label: p.label,
        color: p.color,
        values: p.values,
        timePoints: result.timePoints,
      }));
      const primaryUnit = probes[0]?.type === 'current' ? 'A' : 'V';
      showScopeOverlay(waveforms, primaryUnit);

      // Also render into the bottom-panel chart tab
      renderChart();

      statusText.textContent = `Transiente concluido: ${result.timePoints.length} pontos`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      statusText.textContent = `Erro transiente: ${msg}`;
    }
  }, 10);
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
      'Capacitor', 'Inductor', 'Diode', 'LED', 'Ground',
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
  // Clear existing
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
    const comp: PlacedComponent = {
      id: `c${nextId++}`, type: t.type,
      x: ORIGIN_X, y: ORIGIN_Y + i * SPACING_Y,
      rotation: 0, value: t.value,
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
    const comp: PlacedComponent = {
      id: `c${nextId++}`, type: t.type,
      x: ORIGIN_X + SPACING_X * (col + 1),
      y: ORIGIN_Y + row * SPACING_Y,
      rotation: 0, value: t.value,
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

  // Convert grounds
  for (const g of trackedGrounds) {
    const compId = instanceToId.get(g.instance);
    if (compId) {
      grounds.push({ id: `g${nextId++}`, componentId: compId, pinName: g.pinName });
    }
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
  const hasGrounds = grounds.length > 0;
  const lines: string[] = ['const circuit = new Circuit();'];
  if (hasGrounds) lines.push('const gnd = new Ground();');
  lines.push('');

  // Map component IDs to variable names
  const idToVar = new Map<string, string>();
  for (const comp of components) {
    const varName = comp.label.toLowerCase().replace(/[^a-z0-9]/g, '');
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

  // Wires → .connect() calls
  for (const wire of wires) {
    const from = wire.from as { componentId: string; pinName: string };
    const to = wire.to as { componentId: string; pinName: string };
    const fromVar = idToVar.get(from.componentId);
    const toVar = idToVar.get(to.componentId);
    if (fromVar && toVar) {
      lines.push(`${fromVar}.pin('${from.pinName}').connect(${toVar}.pin('${to.pinName}'));`);
    }
  }

  // Grounds → .connect(gnd.pin('1'))
  for (const g of grounds) {
    const varName = idToVar.get(g.componentId);
    if (varName) {
      lines.push(`${varName}.pin('${g.pinName}').connect(gnd.pin('1'));`);
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

  components.push(v1, r1, l1, c1);

  // Wires: V1+ → R1.1
  wires.push({ id: `w${nextId++}`, from: { componentId: v1.id, pinName: '+' }, to: { componentId: r1.id, pinName: '1' } });
  // R1.2 → L1.1
  wires.push({ id: `w${nextId++}`, from: { componentId: r1.id, pinName: '2' }, to: { componentId: l1.id, pinName: '1' } });
  // L1.2 → C1.1
  wires.push({ id: `w${nextId++}`, from: { componentId: l1.id, pinName: '2' }, to: { componentId: c1.id, pinName: '1' } });
  // C1.2 → V1-
  wires.push({ id: `w${nextId++}`, from: { componentId: c1.id, pinName: '2' }, to: { componentId: v1.id, pinName: '-' } });

  // Ground on V1-
  grounds.push({ id: `g${nextId++}`, componentId: v1.id, pinName: '-' });

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
  } else if (currentTool === 'ground') {
    statusText.textContent = 'Clique em um pino para conectar ao GND';
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
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, w, h);

  // Draw grid in screen space, aligned to world grid
  drawGridPanZoom(ctx, w, h);

  // Apply pan/zoom transform for scene
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // Layer 1: Wires (below everything)
  for (const wire of wires) {
    const from = wire.from as { componentId: string; pinName: string };
    const to = wire.to as { componentId: string; pinName: string };
    const fromComp = components.find(c => c.id === from.componentId);
    const toComp = components.find(c => c.id === to.componentId);
    if (!fromComp || !toComp) continue;
    drawWire(ctx, getPinWorldPos(fromComp, from.pinName), getPinWorldPos(toComp, to.pinName));
  }

  // Wire preview
  if (wireStart) {
    const startComp = components.find(c => c.id === wireStart!.componentId)!;
    drawWirePreview(ctx, getPinWorldPos(startComp, wireStart.pinName), mousePos);
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
  simulate: runSimulation,
  simulateTransient: runTransientSimulation,
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
  h1.textContent = projectName !== 'Sem titulo' ? `Circuit Simulator — ${projectName}` : 'Circuit Simulator';
} else {
  // Set default content
  editorAPI.setFiles([{ name: 'main.js', content: DEFAULT_CODE }]);
}

// Initial render
updateStatus();
render();
