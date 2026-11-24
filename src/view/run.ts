/**
 * Runs the viewer simulation in a Web Worker (keeps the UI responsive) with
 * a main-thread fallback (cooperative yields between phases).
 */
import type { CircuitDoc } from '../doc/types';
import type { SimProgress, SimResult } from './simulate';

export function runSimulation(doc: CircuitDoc, onProgress: (p: SimProgress) => void): Promise<SimResult> {
  if (typeof Worker === 'undefined') return fallback(doc, onProgress);
  return new Promise<SimResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      fallback(doc, onProgress).then(resolve, reject);
      return;
    }
    let settled = false;
    const finish = () => {
      settled = true;
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ type: string } & Record<string, unknown>>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress({ phase: m.phase as SimProgress['phase'], detail: m.detail as string | undefined });
      else if (m.type === 'done') {
        finish();
        resolve(m.result as SimResult);
      } else if (m.type === 'error') {
        finish();
        reject(new Error(String(m.message)));
      }
    };
    worker.onerror = err => {
      if (settled) return;
      finish();
      // A worker that fails to load (e.g. file:// or a blocked module worker): run inline.
      void err;
      fallback(doc, onProgress).then(resolve, reject);
    };
    worker.postMessage({ type: 'run', doc });
  });
}

async function fallback(doc: CircuitDoc, onProgress: (p: SimProgress) => void): Promise<SimResult> {
  const { simulateDoc } = await import('./simulate');
  return simulateDoc(doc, onProgress, { yield: true });
}
