/**
 * Node firmware host: resolves `firmware: './blink.fw.ts'` (relative to the
 * bench file) on disk and gathers the entry plus every file it imports
 * relatively into a FirmwareBundle keyed by cwd-relative POSIX paths — the
 * paths diagnostics print and circuit documents embed as `sources[].path`.
 * Installed by the CLI bench loader (src/cli/load.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setFirmwareHost, relativeImports, FIRMWARE_EXTENSIONS, type FirmwareBundle, type FirmwareHost } from '../firmware';

/** cwd-relative POSIX path; files outside the working directory get `external/<name>`. */
export function sourcePathOf(abs: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return `external/${path.basename(abs)}`;
}

function resolveFile(base: string): string | undefined {
  const candidates = [base];
  const js = base.match(/\.(m|c)?js$/);
  if (js) candidates.push(`${base.slice(0, -js[0].length)}.${js[1] ?? ''}ts`);
  for (const ext of FIRMWARE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of FIRMWARE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile());
}

export const nodeFirmwareHost: FirmwareHost = {
  readBundle(spec: string, fromFile: string | undefined): FirmwareBundle {
    const dir = fromFile ? path.dirname(path.resolve(fromFile)) : process.cwd();
    const abs = resolveFile(path.resolve(dir, spec));
    if (!abs) throw new Error(`firmware file not found: '${spec}' (resolved against ${sourcePathOf(dir) || '.'}/)`);
    const files: Record<string, string> = {};
    const entry = sourcePathOf(abs);
    const queue = [abs];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      files[sourcePathOf(file)] = text;
      if (file.endsWith('.json')) continue;
      for (const dep of relativeImports(text)) {
        const hit = resolveFile(path.resolve(path.dirname(file), dep));
        if (hit) queue.push(hit); // unresolved imports surface as M608 when compiled
      }
    }
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(files).sort()) sorted[k] = files[k];
    return { entry, files: sorted };
  },
};

/** Make firmware paths in benches resolvable from disk (idempotent). */
export function installNodeFirmwareHost(): void {
  setFirmwareHost(nodeFirmwareHost);
}
