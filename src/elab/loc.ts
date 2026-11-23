/**
 * Capture the source location (file:line) of the user code that called into
 * the bench DSL — "sourcemaps for circuits". Every component and assertion
 * carries the location the agent must edit to fix it.
 *
 * Relies on Error().stack. The CLI evaluates bench files under their real
 * filename with line numbers preserved (see src/cli/load.ts), so frames point
 * at the original .ts files. Under vitest, vite's sourcemaps do the same. In
 * environments without stacks this degrades to `undefined`, never throws.
 *
 * Locations are reported relative to the working directory with forward
 * slashes, so RunRecords are identical across machines and operating systems.
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
    // `at fn (path:line:col)` or `at path:line:col`; paths may contain spaces.
    const m = line.match(/\((.+?):(\d+):(\d+)\)$/) ?? line.match(/^\s*at (.+?):(\d+):(\d+)$/);
    if (!m) continue;
    let file = m[1].startsWith('file://') ? decodeURIComponent(m[1].replace(/^file:\/\/\/?/, '')) : m[1];
    // file:///D:/x → D:/x on Windows, file:///home/x → /home/x elsewhere.
    if (m[1].startsWith('file://') && !/^[A-Za-z]:/.test(file)) file = `/${file}`;
    if (selfFile === undefined) selfFile = file;
    if (file === selfFile) continue;
    if (/[\\/]src[\\/]elab[\\/]/.test(file)) continue;
    if (file.includes('node_modules')) continue;
    if (file.startsWith('node:')) continue;
    return `${relativeToCwd(file)}:${m[2]}`;
  }
  return undefined;
}

function relativeToCwd(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') return normalized;
  const cwd = `${process.cwd().replace(/\\/g, '/').replace(/\/$/, '')}/`;
  // Windows paths are case-insensitive (and drive letters vary in case).
  const fold = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(normalized).startsWith(fold(cwd)) ? normalized.slice(cwd.length) : normalized;
}
