import type { ProjectData } from './types';

const PREFIX = 'circuit:';
const AUTOSAVE_KEY = 'circuit:__autosave';

export function saveProject(project: ProjectData): void {
  const data = { ...project, updatedAt: new Date().toISOString() };
  localStorage.setItem(PREFIX + project.name, JSON.stringify(data));
}

export function loadProject(name: string): ProjectData | null {
  const raw = localStorage.getItem(PREFIX + name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectData;
  } catch {
    return null;
  }
}

export function listProjects(): { name: string }[] {
  const result: { name: string }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX) && key !== AUTOSAVE_KEY) {
      result.push({ name: key.slice(PREFIX.length) });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteProject(name: string): void {
  localStorage.removeItem(PREFIX + name);
}

export function exportProject(project: ProjectData): void {
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name}.circuit.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importProject(file: File): Promise<ProjectData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as ProjectData;
        if (!data.version || !data.name || !data.files) {
          reject(new Error('Invalid project format'));
          return;
        }
        resolve(data);
      } catch {
        reject(new Error('Error reading JSON file'));
      }
    };
    reader.onerror = () => reject(new Error('Error reading file'));
    reader.readAsText(file);
  });
}

export function autoSave(project: ProjectData): void {
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
}

export function loadAutoSave(): ProjectData | null {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectData;
  } catch {
    return null;
  }
}

export function clearAutoSave(): void {
  localStorage.removeItem(AUTOSAVE_KEY);
}
