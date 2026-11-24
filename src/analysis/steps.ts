/**
 * "Colorless" analyses: an analysis written once as a generator that yields
 * promises only where an asynchronous co-simulation needs them (MCU firmware
 * is `async` code, see src/mcu), driven either synchronously (`drainSync`:
 * every existing caller, nothing is ever yielded for a circuit without
 * firmware) or asynchronously (`drainAsync`: runLadderAsync, the CLI).
 *
 * A generator `Steps<T>` yields `Promise<unknown>` and receives the resolved
 * value back from `yield`; it returns T.
 */
export type Steps<T> = Generator<Promise<unknown>, T, unknown>;

/** Thrown by drainSync when the analysis needs asynchronous work (firmware). */
export class AsyncAnalysisError extends Error {
  constructor() {
    super(
      'this circuit co-simulates microcontroller firmware, which runs asynchronously: use runLadderAsync() (the CLI does) instead of runLadder()',
    );
    this.name = 'AsyncAnalysisError';
  }
}

/** Run a step generator to completion synchronously; throws AsyncAnalysisError if it yields. */
export function drainSync<T>(g: Steps<T>): T {
  const r = g.next();
  if (r.done) return r.value;
  // Swallow the pending promise's rejection: nobody will await it.
  r.value.then(undefined, () => undefined);
  try {
    g.return(undefined as T);
  } catch {
    // ignore cleanup errors: the analysis is abandoned
  }
  throw new AsyncAnalysisError();
}

/** Run a step generator to completion, awaiting every yielded promise. */
export async function drainAsync<T>(g: Steps<T>): Promise<T> {
  let r = g.next();
  while (!r.done) {
    let value: unknown;
    try {
      value = await r.value;
    } catch (err) {
      r = g.throw(err);
      continue;
    }
    r = g.next(value);
  }
  return r.value;
}
