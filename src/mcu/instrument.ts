/**
 * Loop instrumentation for busy-loop detection, plus the small JS tokenizer
 * it (and the firmware lint) is built on. Pure, browser-safe, no parser
 * dependency.
 *
 * `instrumentLoops(js)` rewrites every `while (c)`, `do … while (c)` and
 * classic `for (i; c; u)` so the condition first calls the loop guard:
 *
 *     while (digitalRead(2) === LOW) {}
 *  →  while (__cvLoopGuard() && (digitalRead(2) === LOW)) {}
 *
 * The guard counts iterations against the running MCU's per-yield budget and
 * throws (diagnostic M602, at the loop's line) when exceeded, so even a loop
 * that calls no Arduino API cannot hang the simulator. No newlines are added:
 * line numbers — and therefore stack-trace locations — are preserved. Apply
 * it to already-transpiled JavaScript (after sucrase).
 */

export type TokenType = 'ident' | 'number' | 'string' | 'template' | 'regex' | 'punct' | 'comment';

export interface Token {
  type: TokenType;
  start: number;
  end: number;
  /** Source text of the token. */
  text: string;
}

const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const isIdStart = (c: string): boolean => /[A-Za-z_$#]/.test(c) || c > '\u007f';
const isIdPart = (c: string): boolean => /[\w$]/.test(c) || c > '\u007f';

/**
 * Tokenize JavaScript/TypeScript source. Good enough for locating loop
 * keywords, call sites and their parentheses; not a validating lexer.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  // Stack of brace depths for template substitutions `${ … }`.
  const templateStack: number[] = [];
  let braceDepth = 0;
  let i = 0;
  const n = src.length;

  const lastSignificant = (): Token | undefined => {
    for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].type !== 'comment') return tokens[k];
    return undefined;
  };
  const regexAllowed = (): boolean => {
    const prev = lastSignificant();
    if (!prev) return true;
    if (prev.type === 'ident') return REGEX_AFTER_KEYWORDS.has(prev.text);
    if (prev.type === 'punct') return !(prev.text === ')' || prev.text === ']' || prev.text === '}');
    return false;
  };
  const push = (type: TokenType, start: number, end: number): void => {
    tokens.push({ type, start, end, text: src.slice(start, end) });
  };

  /** Scan template characters from i (just after ` or }) to the closing ` or ${. */
  const scanTemplateChunk = (start: number): void => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        push('template', start, i);
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        push('template', start, i);
        templateStack.push(braceDepth);
        braceDepth = 0;
        return;
      }
      i++;
    }
    push('template', start, i);
  };

  while (i < n) {
    const c = src[i];
    const start = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      push('comment', start, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i = Math.min(n, i + 1);
      push('string', start, i);
      continue;
    }
    if (c === '`') {
      i++;
      scanTemplateChunk(start);
      continue;
    }
    if (c === '}' && templateStack.length > 0 && braceDepth === 0) {
      braceDepth = templateStack.pop()!;
      i++;
      scanTemplateChunk(start);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      i++;
      while (i < n && (/[\w.]/.test(src[i]) || ((src[i] === '+' || src[i] === '-') && /[eE]/.test(src[i - 1]) && !/^0[xX]/.test(src.slice(start, i))))) i++;
      push('number', start, i);
      continue;
    }
    if (isIdStart(c)) {
      i++;
      while (i < n && isIdPart(src[i])) i++;
      push('ident', start, i);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const d = src[i];
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        i++;
      }
      i = Math.min(n, i + 1);
      while (i < n && isIdPart(src[i])) i++; // flags
      push('regex', start, i);
      continue;
    }
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    i++;
    push('punct', start, i);
  }
  return tokens;
}

/** Index of the token closing the bracket opened at tokens[open], or -1. */
export function matchBracket(tokens: Token[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'punct') continue;
    if (pairs[t.text]) stack.push(pairs[t.text]);
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      if (stack.pop() !== t.text) return -1;
      if (stack.length === 0) return k;
    }
  }
  return -1;
}

/** Next non-comment token index after k, or -1. */
export function nextSignificant(tokens: Token[], k: number): number {
  for (let j = k + 1; j < tokens.length; j++) if (tokens[j].type !== 'comment') return j;
  return -1;
}

/** Previous non-comment token index before k, or -1. */
export function prevSignificant(tokens: Token[], k: number): number {
  for (let j = k - 1; j >= 0; j--) if (tokens[j].type !== 'comment') return j;
  return -1;
}

export const LOOP_GUARD_CALL = '__cvLoopGuard()';

/** Insert the loop guard into every while / do-while / classic for loop condition. */
export function instrumentLoops(code: string, guard = LOOP_GUARD_CALL): string {
  const tokens = tokenize(code);
  const inserts: { at: number; text: string }[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'ident' || (t.text !== 'while' && t.text !== 'for')) continue;
    const prev = prevSignificant(tokens, k);
    if (prev >= 0 && tokens[prev].type === 'punct' && tokens[prev].text === '.') continue; // obj.while
    let open = nextSignificant(tokens, k);
    if (open < 0) continue;
    if (t.text === 'for' && tokens[open].type === 'ident' && tokens[open].text === 'await') continue; // for await (… of …)
    if (tokens[open].type !== 'punct' || tokens[open].text !== '(') continue;
    const close = matchBracket(tokens, open);
    if (close < 0) continue;
    if (t.text === 'while') {
      if (nextSignificant(tokens, open) === close) continue; // `while ()` is a syntax error anyway
      inserts.push({ at: tokens[open].end, text: `${guard} && (` });
      inserts.push({ at: tokens[close].start, text: ')' });
      continue;
    }
    // for: locate the two top-level semicolons.
    const semis: number[] = [];
    let depth = 0;
    for (let j = open + 1; j < close; j++) {
      const u = tokens[j];
      if (u.type !== 'punct') continue;
      if (u.text === '(' || u.text === '[' || u.text === '{') depth++;
      else if (u.text === ')' || u.text === ']' || u.text === '}') depth--;
      else if (u.text === ';' && depth === 0) semis.push(j);
    }
    if (semis.length !== 2) continue; // for…in / for…of: finite by construction
    const [s1, s2] = semis;
    if (nextSignificant(tokens, s1) === s2) {
      inserts.push({ at: tokens[s1].end, text: ` ${guard}` });
    } else {
      inserts.push({ at: tokens[s1].end, text: ` ${guard} && (` });
      inserts.push({ at: tokens[s2].start, text: ')' });
    }
    open = close;
  }
  if (inserts.length === 0) return code;
  inserts.sort((a, b) => a.at - b.at);
  let out = '';
  let last = 0;
  for (const ins of inserts) {
    out += code.slice(last, ins.at) + ins.text;
    last = ins.at;
  }
  return out + code.slice(last);
}

/** 1-based line number of a character offset. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}
