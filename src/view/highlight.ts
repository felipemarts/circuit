/**
 * Syntax highlighting for the viewer's Sources panel: the firmware
 * (TypeScript / JavaScript) and VHDL files a circuit document embeds in
 * `sources[]`. Returns HTML (escaped) with `tok-*` spans — the same token
 * classes the docs pages use (src/site/highlight.ts), so one stylesheet rule
 * set colours both.
 */
import { highlightJSON, highlightTS } from '../site/highlight';

export type SourceLang = 'ts' | 'js' | 'json' | 'vhdl' | 'text';

export function languageOf(path: string): SourceLang {
  const ext = path.toLowerCase().match(/\.([a-z]+)$/)?.[1] ?? '';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts' || ext === 'tsx') return 'ts';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (ext === 'json') return 'json';
  if (ext === 'vhd' || ext === 'vhdl') return 'vhdl';
  return 'text';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const VHDL_KEYWORDS = new Set(
  (
    'library use entity is port generic in out inout buffer end architecture of begin signal variable constant type subtype ' +
    'process if then elsif else case when others for loop generate while exit next null wait until on after assert report severity ' +
    'component map all downto to range array record function procedure return package body with select and or nand nor xor xnor not ' +
    'mod rem abs sll srl sla sra rol ror others transport inertial'
  ).split(' '),
);
const VHDL_TYPES = new Set(['std_logic', 'std_logic_vector', 'unsigned', 'signed', 'integer', 'natural', 'positive', 'boolean', 'bit', 'bit_vector', 'time', 'real', 'string', 'character']);

export function highlightVHDL(src: string): string {
  const re = /(--[^\n]*)|('[01XZUWLH-]'|"[01XZUWLH-_]*"|[xXbBoO]"[0-9a-fA-F_]*")|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\s*(?:ns|us|ms|ps|fs|sec|min|hr)?\b)|([A-Za-z_][\w]*)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
    else if (m[4]) {
      const w = m[4];
      const l = w.toLowerCase();
      if (VHDL_KEYWORDS.has(l)) out += `<span class="tok-k">${esc(w)}</span>`;
      else if (VHDL_TYPES.has(l)) out += `<span class="tok-t">${esc(w)}</span>`;
      else if (/^(rising_edge|falling_edge|to_unsigned|to_signed|to_integer|resize|shift_left|shift_right|std_logic_vector|unsigned|signed)$/.test(l)) out += `<span class="tok-f">${esc(w)}</span>`;
      else out += esc(w);
    }
  }
  return out + esc(src.slice(last));
}

/** Highlighted HTML of a whole file (no line splitting; callers split on '\n' — spans never cross lines except block comments, which are re-opened per line). */
export function highlightSource(text: string, lang: SourceLang): string {
  if (lang === 'ts' || lang === 'js') return highlightTS(text);
  if (lang === 'json') return highlightJSON(text);
  if (lang === 'vhdl') return highlightVHDL(text);
  return esc(text);
}

/**
 * Highlighted lines: the file is highlighted as a whole (so multi-line
 * comments / template strings work) and then split per line with open spans
 * carried over, so each line is a self-contained HTML fragment.
 */
export function highlightLines(text: string, lang: SourceLang): string[] {
  const html = highlightSource(text.replace(/\r\n?/g, '\n'), lang);
  const lines: string[] = [];
  let open: string | null = null;
  for (const raw of html.split('\n')) {
    let line = open ? `<span class="${open}">${raw}` : raw;
    // Track an unterminated span on this line.
    const re = /<span class="([^"]+)">|<\/span>/g;
    const stack: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[1]) stack.push(m[1]);
      else stack.pop();
    }
    open = stack.length ? stack[stack.length - 1] : null;
    if (open) line += '</span>';
    lines.push(line);
  }
  return lines;
}
