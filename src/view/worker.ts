/**
 * Web Worker entry: runs the viewer simulation off the UI thread. Messages:
 *   in : { type: 'run', doc }
 *   out: { type: 'progress', phase, detail? } · { type: 'done', result } · { type: 'error', message }
 */
import { simulateDoc } from './simulate';
import type { CircuitDoc } from '../doc/types';

const ctx = self as unknown as { postMessage(msg: unknown): void; onmessage: ((e: MessageEvent) => void) | null };

ctx.onmessage = async (e: MessageEvent<{ type: string; doc: CircuitDoc }>) => {
  if (e.data?.type !== 'run') return;
  try {
    const result = await simulateDoc(e.data.doc, p => ctx.postMessage({ type: 'progress', ...p }), { yield: false });
    ctx.postMessage({ type: 'done', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
