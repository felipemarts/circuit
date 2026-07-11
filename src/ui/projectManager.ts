import type { PlacedComponent, Wire, GroundNode, Probe, ProjectData, ProjectFile } from './types';
import { saveProject, loadProject, listProjects, deleteProject, exportProject, importProject } from './projectStore';
import type { CodeEditorAPI } from './codeEditor';
import { EXAMPLE_PROJECTS } from './examples';

export interface ProjectBridge {
  getCanvasState(): { components: PlacedComponent[]; wires: Wire[]; grounds: GroundNode[]; probes: Probe[] };
  setCanvasState(state: { components: PlacedComponent[]; wires: Wire[]; grounds: GroundNode[]; probes: Probe[] }): void;
  getEditorAPI(): CodeEditorAPI;
  getSettings(): { simDt: string; simDuration: string };
  setSettings(s: { simDt: string; simDuration: string }): void;
  getView(): { panX: number; panY: number; zoom: number };
  setView(v: { panX: number; panY: number; zoom: number }): void;
  render(): void;
  getProjectName(): string;
  setProjectName(name: string): void;
}

export interface ProjectManagerAPI {
  /** Loads an example by slug (deep link `?example=<slug>`). Returns false if the slug does not exist. */
  loadExampleBySlug(slug: string): boolean;
}

export function initProjectManager(bridge: ProjectBridge): ProjectManagerAPI {
  const dropdown = document.getElementById('project-dropdown')!;
  const btnProject = document.getElementById('btn-project')!;
  const dialog = document.getElementById('project-dialog')!;
  const dialogTitle = document.getElementById('project-dialog-title')!;
  const dialogBody = document.getElementById('project-dialog-body')!;
  const dialogOk = document.getElementById('project-dialog-ok')!;
  const dialogCancel = document.getElementById('project-dialog-cancel')!;
  const fileInput = document.getElementById('import-file-input') as HTMLInputElement;

  let dialogResolve: ((value: string | null) => void) | null = null;

  // ─── Dropdown toggle ──────────────────────────────────────────────────

  btnProject.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('visible');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('visible');
  });

  dropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // ─── Dialog helpers ───────────────────────────────────────────────────

  function showDialog(title: string, bodyHTML: string, showInput = false): Promise<string | null> {
    dialogTitle.textContent = title;
    dialogBody.innerHTML = bodyHTML;
    dialog.classList.add('visible');

    return new Promise(resolve => {
      dialogResolve = resolve;
    });
  }

  function hideDialog() {
    dialog.classList.remove('visible');
    dialogResolve = null;
  }

  dialogOk.addEventListener('click', () => {
    const input = dialogBody.querySelector('input') as HTMLInputElement | null;
    if (dialogResolve) dialogResolve(input?.value ?? '');
    hideDialog();
  });

  dialogCancel.addEventListener('click', () => {
    if (dialogResolve) dialogResolve(null);
    hideDialog();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      if (dialogResolve) dialogResolve(null);
      hideDialog();
    }
  });

  // ─── Gather project data ──────────────────────────────────────────────

  function gatherProject(): ProjectData {
    return {
      version: 1,
      name: bridge.getProjectName(),
      files: bridge.getEditorAPI().getFiles(),
      canvas: bridge.getCanvasState(),
      settings: bridge.getSettings(),
      view: bridge.getView(),
    };
  }

  function loadProjectData(project: ProjectData) {
    bridge.setProjectName(project.name);
    bridge.getEditorAPI().setFiles(project.files);
    bridge.setCanvasState(project.canvas);
    bridge.setSettings(project.settings);
    if (project.view) bridge.setView(project.view);
    bridge.render();
  }

  function loadExampleBySlug(slug: string): boolean {
    const example = EXAMPLE_PROJECTS.find(p => p.slug === slug);
    if (!example) return false;
    // Deep clone so we don't mutate the example template
    const clone = JSON.parse(JSON.stringify(example)) as ProjectData;
    loadProjectData(clone);
    updateTitle();
    return true;
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  dropdown.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    dropdown.classList.remove('visible');

    switch (action) {
      case 'new': {
        if (!confirm('Create a new project? Unsaved changes will be lost.')) return;
        bridge.setProjectName('Untitled');
        bridge.getEditorAPI().setFiles([{ name: 'main.js', content: '' }]);
        bridge.setCanvasState({ components: [], wires: [], grounds: [], probes: [] });
        bridge.render();
        break;
      }

      case 'save': {
        const name = bridge.getProjectName();
        if (name === 'Untitled') {
          // Fall through to save-as
          const result = await showDialog('Save Project', `
            <input type="text" placeholder="Project name" style="width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;margin-top:8px;" />
          `);
          if (!result) return;
          bridge.setProjectName(result);
        }
        const project = gatherProject();
        saveProject(project);
        updateTitle();
        break;
      }

      case 'save-as': {
        const result = await showDialog('Save As', `
          <input type="text" placeholder="Project name" value="${bridge.getProjectName()}" style="width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;margin-top:8px;" />
        `);
        if (!result) return;
        bridge.setProjectName(result);
        const project = gatherProject();
        saveProject(project);
        updateTitle();
        break;
      }

      case 'open': {
        const projects = listProjects();
        if (projects.length === 0) {
          alert('No saved projects.');
          return;
        }
        const listHTML = projects.map(p => `
          <div class="project-list-item" data-name="${p.name}">
            <span class="project-list-name">${p.name}</span>
            <div class="project-list-actions">
              <button class="project-list-open" data-open="${p.name}">Open</button>
              <button class="project-list-delete" data-delete="${p.name}">Delete</button>
            </div>
          </div>
        `).join('');
        await showDialog('Open Project', `<div class="project-list">${listHTML}</div>`);
        break;
      }

      case 'export': {
        const project = gatherProject();
        exportProject(project);
        break;
      }

      case 'import': {
        fileInput.click();
        break;
      }

      case 'examples': {
        const listHTML = EXAMPLE_PROJECTS.map((p, i) => `
          <div class="project-list-item" data-example="${i}">
            <span class="project-list-name">${p.name}</span>
            <button class="project-list-open" data-load-example="${i}">Load</button>
          </div>
        `).join('');
        await showDialog('Examples', `<div class="project-list">${listHTML}</div>`);
        break;
      }
    }
  });

  // Handle clicks inside dialog (open/delete/load-example)
  dialogBody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const openName = target.dataset.open;
    if (openName) {
      const project = loadProject(openName);
      if (project) {
        loadProjectData(project);
        updateTitle();
      }
      hideDialog();
      return;
    }

    const deleteName = target.dataset.delete;
    if (deleteName) {
      if (confirm(`Delete project "${deleteName}"?`)) {
        deleteProject(deleteName);
        // Remove the item from the list
        const item = target.closest('.project-list-item');
        if (item) item.remove();
      }
      return;
    }

    const exIdx = target.dataset.loadExample;
    if (exIdx !== undefined) {
      const example = EXAMPLE_PROJECTS[parseInt(exIdx)];
      if (example) {
        // Deep clone
        const clone = JSON.parse(JSON.stringify(example)) as ProjectData;
        loadProjectData(clone);
        updateTitle();
      }
      hideDialog();
      return;
    }
  });

  // File import
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const project = await importProject(file);
      loadProjectData(project);
      updateTitle();
    } catch (err) {
      alert((err as Error).message);
    }
    fileInput.value = '';
  });

  // ─── Title update ─────────────────────────────────────────────────────

  function updateTitle() {
    const h1 = document.querySelector('header h1')!;
    const name = bridge.getProjectName();
    h1.textContent = name !== 'Untitled' ? `Circuit Forge — ${name}` : 'Circuit Forge';
  }

  updateTitle();

  return { loadExampleBySlug };
}
