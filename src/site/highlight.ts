/**
 * Tiny, dependency-free syntax highlighter for the docs and landing pages.
 * Supports `ts` (TypeScript/JavaScript), `sh` (shell transcripts) and `json`.
 * It runs over `<code data-lang="…">` elements and wraps tokens in spans.
 */

const TS_KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'new', 'return', 'function',
  'if', 'else', 'for', 'while', 'true', 'false', 'null', 'undefined', 'class', 'extends',
  'type', 'interface', 'async', 'await', 'typeof', 'this', 'throw', 'try', 'catch',
]);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${esc(text)}</span>`;
}

export function highlightTS(src: string): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Z][A-Za-z0-9_]*)|([a-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) out += span('tok-c', m[1]);
    else if (m[2]) out += span('tok-s', m[2]);
    else if (m[3]) out += span('tok-n', m[3]);
    else if (m[4]) out += TS_KEYWORDS.has(m[4]) ? span('tok-k', m[4]) : span('tok-f', m[4]);
    else if (m[5]) out += span('tok-t', m[5]);
    else if (m[6]) out += TS_KEYWORDS.has(m[6]) ? span('tok-k', m[6]) : esc(m[6]);
  }
  return out + esc(src.slice(last));
}

export function highlightJSON(src: string): string {
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b|(\/\/[^\n]*)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] && m[2]) out += span('tok-f', m[1]) + esc(m[2]);
    else if (m[1]) out += span('tok-s', m[1]);
    else if (m[3]) out += span('tok-n', m[3]);
    else if (m[4]) out += span('tok-k', m[4]);
    else if (m[5]) out += span('tok-c', m[5]);
  }
  return out + esc(src.slice(last));
}

export function highlightSH(src: string): string {
  return src
    .split('\n')
    .map(line => {
      const cm = /^(\s*)(#.*)$/.exec(line);
      if (cm) return esc(cm[1]) + span('tok-c', cm[2]);
      const pm = /^(\$\s)(.*)$/.exec(line);
      if (pm) {
        const rest = pm[2];
        const hashIdx = rest.indexOf('   #');
        const cmdPart = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
        const comment = hashIdx >= 0 ? rest.slice(hashIdx) : '';
        const words = cmdPart.split(/(\s+)/).map((w, i) => {
          if (/^\s+$/.test(w) || w === '') return esc(w);
          if (i === 0) return span('tok-f', w);
          if (w.startsWith('--') || w.startsWith('-')) return span('tok-flag', w);
          if (/^\d/.test(w)) return span('tok-n', w);
          return span('tok-cmd', w);
        });
        return span('tok-prompt', pm[1]) + words.join('') + (comment ? span('tok-c', comment) : '');
      }
      return span('tok-p', line);
    })
    .join('\n');
}

export function highlightElement(el: HTMLElement): void {
  if (el.dataset.highlighted === '1') return;
  const lang = el.dataset.lang;
  const src = el.textContent ?? '';
  let html: string | null = null;
  if (lang === 'ts' || lang === 'js') html = highlightTS(src);
  else if (lang === 'json') html = highlightJSON(src);
  else if (lang === 'sh' || lang === 'bash') html = highlightSH(src);
  if (html !== null) {
    el.innerHTML = html;
    el.dataset.highlighted = '1';
  }
}

export function highlightAll(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('code[data-lang]').forEach(highlightElement);
}
