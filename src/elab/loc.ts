/**
 * Capture the source location (file:line) of the user code that called into
 * the bench DSL — "sourcemaps for circuits". Every component and assertion
 * carries the location the agent must edit to fix it.
 *
 * Relies on Error().stack. Under the forge CLI, bench files are bundled with
 * inline sourcemaps and `process.setSourceMapsEnabled(true)`, so frames map
 * back to the original .ts files. Under vitest, vite does the same. In
 * environments without stacks this degrades to `undefined`, never throws.
 */
export function captureLoc(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split('\n').slice(1);
  // Frame 0 is captureLoc itself. When sourcemaps are unavailable, every
  // platform frame reports the same bundled file as frame 0 — skipping that
  // file makes the walk find the separately-bundled bench file or correctly
  // degrade to undefined, instead of pinning everything to one wrong line.
  let selfFile: string | undefined;
  for (const line of lines) {
    const m = line.match(/\(?((?:file:\/\/)?[^()\s]+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    let file = m[1].replace(/^file:\/\//, '');
    if (selfFile === undefined) selfFile = file;
    if (file === selfFile) continue;
    if (/[\\/]src[\\/]elab[\\/]/.test(file)) continue;
    if (file.includes('node_modules')) continue;
    if (file.startsWith('node:')) continue;
    const cwd =
      typeof process !== 'undefined' && typeof process.cwd === 'function' ? `${process.cwd()}/` : '';
    if (cwd && file.startsWith(cwd)) file = file.slice(cwd.length);
    return `${file}:${m[2]}`;
  }
  return undefined;
}
