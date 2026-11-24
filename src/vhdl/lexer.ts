/**
 * Hand-written VHDL lexer. Identifiers and keywords are case-insensitive and
 * come out lowercased; string/character literal contents keep their case.
 */
import type { Loc } from './source';

export type TokKind = 'id' | 'kw' | 'int' | 'real' | 'char' | 'str' | 'bitstr' | 'op' | 'eof';

export interface Token {
  kind: TokKind;
  /** Lowercased for id/kw; operator text for op; contents for char/str; expanded '0'/'1'… digits for bitstr. */
  text: string;
  /** Exact source text. */
  raw: string;
  /** Numeric value for int/real. */
  value?: number;
  loc: Loc;
}

export interface LexError {
  message: string;
  loc: Loc;
  note?: string;
}

export const KEYWORDS = new Set(
  (
    'abs access after alias all and architecture array assert assume attribute begin block body buffer bus case component ' +
    'configuration constant context cover default disconnect downto else elsif end entity exit file for force function ' +
    'generate generic group guarded if impure in inertial inout is label library linkage literal loop map mod nand new next ' +
    'nor not null of on open or others out package parameter port postponed procedure process property protected pure range ' +
    'record register reject release rem report restrict return rol ror select sequence severity shared signal sla sll sra srl ' +
    'strong subtype then to transport type unaffected units until use variable vmode vprop vunit wait when while with xnor xor'
  ).split(' '),
);

// Longest first.
const OPERATORS = ['?/=', '?<=', '?>=', '=>', '<=', ':=', '/=', '>=', '**', '<>', '??', '?=', '?<', '?>', '(', ')', ',', ';', ':', '.', '&', "'", '*', '+', '-', '/', '<', '=', '>', '|', '[', ']'];

const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isExtDigit = (c: string): boolean => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

export function lex(text: string, src: number): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = text.length;
  const loc = (at: number): Loc => ({ src, line, col: at - lineStart + 1 });
  const push = (kind: TokKind, t: string, raw: string, at: number, l: Loc, value?: number): void => {
    tokens.push(value === undefined ? { kind, text: t, raw, loc: l } : { kind, text: t, raw, value, loc: l });
    void at;
  };

  while (i < n) {
    const c = text[i];
    // newlines / whitespace
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ') {
      i++;
      continue;
    }
    // comments
    if (c === '-' && text[i + 1] === '-') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = loc(i);
      i += 2;
      let closed = false;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (text[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (!closed) errors.push({ message: 'unterminated /* comment', loc: start, note: 'a block comment must be closed with */' });
      continue;
    }
    const at = i;
    const l = loc(i);

    // bit-string literal: [size] base "…"  (base: b o x d, optionally prefixed u/s)
    const bs = text.slice(i).match(/^(\d+)?([uUsS]?[bBoOxXdD])"/);
    if (bs && (bs[1] !== undefined || !isLetter(text[i - 1] ?? '') && !isDigit(text[i - 1] ?? '') && text[i - 1] !== '_')) {
      const start = i;
      i += bs[0].length;
      let body = '';
      while (i < n && text[i] !== '"' && text[i] !== '\n') body += text[i++];
      if (text[i] !== '"') {
        errors.push({ message: 'unterminated bit-string literal', loc: l, note: 'close the literal with a double quote: x"FF"' });
        continue;
      }
      i++;
      const raw = text.slice(start, i);
      const expanded = expandBitString(bs[2].toLowerCase(), body, bs[1] !== undefined ? Number(bs[1]) : undefined);
      if (typeof expanded !== 'string') {
        errors.push({ message: `invalid bit-string literal ${raw}: ${expanded.error}`, loc: l, note: 'b"…" takes 0/1, o"…" octal digits, x"…" hex digits (underscores allowed); std_logic metavalues like X or Z are allowed as whole digits' });
        continue;
      }
      push('bitstr', expanded, raw, at, l);
      continue;
    }

    // identifiers / keywords
    if (isLetter(c)) {
      let j = i + 1;
      while (j < n && (isLetter(text[j]) || isDigit(text[j]) || text[j] === '_')) j++;
      const raw = text.slice(i, j);
      const lower = raw.toLowerCase();
      if (/__/.test(raw) || raw.endsWith('_')) {
        errors.push({ message: `invalid identifier '${raw}': VHDL identifiers cannot contain consecutive underscores or end with one`, loc: l, note: 'rename it, e.g. use a single underscore' });
      }
      i = j;
      push(KEYWORDS.has(lower) ? 'kw' : 'id', lower, raw, at, l);
      continue;
    }
    if (c === '\\') {
      errors.push({ message: 'extended identifiers (\\name\\) are not supported', loc: l, note: 'use a basic identifier: letters, digits and single underscores' });
      i++;
      while (i < n && text[i] !== '\\' && text[i] !== '\n') i++;
      if (text[i] === '\\') i++;
      continue;
    }

    // numbers: decimal, based (16#FF#), real, exponent
    if (isDigit(c)) {
      let j = i;
      while (j < n && (isDigit(text[j]) || text[j] === '_')) j++;
      const intPart = text.slice(i, j).replace(/_/g, '');
      if (text[j] === '#' || (text[j] === ':' && isExtDigit(text[j + 1] ?? ''))) {
        const delim = text[j];
        const base = Number(intPart);
        let k = j + 1;
        while (k < n && (isExtDigit(text[k]) || text[k] === '_' || text[k] === '.')) k++;
        const digits = text.slice(j + 1, k).replace(/_/g, '');
        if (text[k] !== delim || base < 2 || base > 16 || digits.length === 0 || digits.includes('.')) {
          errors.push({ message: `invalid based literal ${text.slice(i, k + 1)}`, loc: l, note: 'write based integers as 16#FF#, 2#1010_0101# (base 2..16, no fraction)' });
          i = k + 1;
          continue;
        }
        let value = 0;
        let bad = false;
        for (const d of digits.toLowerCase()) {
          const v = parseInt(d, 16);
          if (v >= base) bad = true;
          value = value * base + v;
        }
        k++;
        let exp = 0;
        const em = text.slice(k).match(/^[eE]\+?(\d+)/);
        if (em) {
          exp = Number(em[1]);
          k += em[0].length;
        }
        if (bad) {
          errors.push({ message: `digit out of range for base ${base} in ${text.slice(i, k)}`, loc: l });
          i = k;
          continue;
        }
        value *= base ** exp;
        push('int', String(value), text.slice(i, k), at, l, value);
        i = k;
        continue;
      }
      let isReal = false;
      let k = j;
      if (text[k] === '.' && isDigit(text[k + 1] ?? '')) {
        isReal = true;
        k++;
        while (k < n && (isDigit(text[k]) || text[k] === '_')) k++;
      }
      const em = text.slice(k).match(/^[eE][+-]?\d+/);
      if (em) {
        if (em[0].includes('-') && !isReal) {
          errors.push({ message: `negative exponent in integer literal ${text.slice(i, k + em[0].length)}`, loc: l, note: 'an integer literal cannot have a negative exponent; write a real literal like 1.0e-3' });
        }
        k += em[0].length;
      }
      const raw = text.slice(i, k);
      const value = Number(raw.replace(/_/g, ''));
      if (isLetter(text[k] ?? '')) {
        // e.g. '10ns' — VHDL needs a space before the unit.
        let m = k;
        while (m < n && (isLetter(text[m]) || isDigit(text[m]) || text[m] === '_')) m++;
        errors.push({ message: `invalid literal '${text.slice(i, m)}'`, loc: l, note: 'separate a number from its unit with a space: 10 ns' });
        i = m;
        continue;
      }
      push(isReal ? 'real' : 'int', String(value), raw, at, l, value);
      i = k;
      continue;
    }

    // character literal vs attribute tick
    if (c === "'") {
      const prev = tokens[tokens.length - 1];
      const tick = prev && (prev.kind === 'id' || (prev.kind === 'op' && (prev.text === ')' || prev.text === ']')) || (prev.kind === 'kw' && (prev.text === 'all' || prev.text === 'range')));
      if (!tick && text[i + 2] === "'" && text[i + 1] !== '\n') {
        push('char', text[i + 1], text.slice(i, i + 3), at, l);
        i += 3;
        continue;
      }
      push('op', "'", "'", at, l);
      i++;
      continue;
    }

    // string literal
    if (c === '"') {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        s += text[j++];
      }
      if (!closed) {
        errors.push({ message: 'unterminated string literal', loc: l, note: 'a string literal must close on the same line: "0101"' });
        i = j;
        continue;
      }
      push('str', s, text.slice(i, j), at, l);
      i = j;
      continue;
    }

    // operators
    let matched = false;
    for (const op of OPERATORS) {
      if (text.startsWith(op, i)) {
        push('op', op, op, at, l);
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    errors.push({
      message: `invalid character ${JSON.stringify(c)} in VHDL source`,
      loc: l,
      note: c === '`' || c === '{' || c === '}' || c === '$' ? 'this looks like Verilog or template text; VHDL does not use this character' : undefined,
    });
    i++;
  }
  tokens.push({ kind: 'eof', text: '', raw: '', loc: loc(i) });
  return { tokens, errors };
}

/** Expand a bit-string literal body into std_logic characters ('0','1' or metavalue digits). */
function expandBitString(base: string, body: string, size: number | undefined): string | { error: string } {
  const digits = body.replace(/_/g, '');
  const signed = base.startsWith('s');
  const b = base.replace(/^[us]/, '');
  let bits = '';
  if (b === 'd') {
    if (!/^\d+$/.test(digits)) return { error: 'decimal bit strings take only digits 0-9' };
    if (size === undefined) return { error: 'a decimal bit string needs a width, e.g. 8d"200"' };
    let v = BigInt(digits);
    for (let k = 0; k < size; k++) {
      bits = (v & 1n ? '1' : '0') + bits;
      v >>= 1n;
    }
    if (v !== 0n) return { error: `value does not fit in ${size} bits` };
    return bits;
  }
  const per = b === 'b' ? 1 : b === 'o' ? 3 : 4;
  for (const ch of digits) {
    const up = ch.toUpperCase();
    if ('XZUWLH-'.includes(up) && per > 1) {
      bits += up.repeat(per);
      continue;
    }
    const v = parseInt(ch, 16);
    if (Number.isNaN(v) || v >= 2 ** per) {
      if (per === 1 && 'XZUWLH-'.includes(up)) {
        bits += up;
        continue;
      }
      return { error: `'${ch}' is not a valid digit` };
    }
    bits += v.toString(2).padStart(per, '0');
  }
  if (size !== undefined) {
    if (bits.length > size) {
      const extra = bits.slice(0, bits.length - size);
      const fill = signed ? bits[bits.length - size] : '0';
      if ([...extra].some(x => x !== fill)) return { error: `value does not fit in ${size} bits` };
      bits = bits.slice(bits.length - size);
    } else if (bits.length < size) {
      const fill = signed && bits.length > 0 ? bits[0] : '0';
      bits = fill.repeat(size - bits.length) + bits;
    }
  }
  return bits;
}
