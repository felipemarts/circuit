import type { Diagnostic } from '../schema/types';
import { canonicalJson } from './canonical';
import { canonicalizeDoc, stripLocations } from './convert';
import { CircuitDocError, docDiagnostic } from './errors';
import type { CircuitDoc } from './types';
import { validateCircuitDoc, type ComponentDefinitions } from './validate';

/**
 * Share links: the whole circuit document lives in the URL fragment, so no
 * server ever sees or stores it (the fragment is never sent in HTTP requests).
 *
 *   <baseUrl>#c=1.<base64url(deflate-raw(utf8(canonical JSON)))>
 *
 * `1.` versions the payload ENCODING (not the document schema, which is
 * inside the JSON). Compression uses the platform CompressionStream
 * ('deflate-raw'): browsers and Node ≥ 20.12 — no dependencies.
 */

export const DEFAULT_SHARE_BASE_URL = 'https://circuitsvibe.com/app.html';
/** Payload encoding version written by this implementation. */
export const SHARE_ENCODING_VERSION = 1;
/** Above this many characters a link may be truncated by chat apps / mail clients (warning T018). */
export const SHARE_WARN_LENGTH = 8 * 1024;
/** Hard cap on link length (T015): Chromium refuses URLs longer than 2 MiB. */
export const SHARE_MAX_LENGTH = 2 * 1024 * 1024;
/** Hard cap on the decompressed document (T015 on decode): guards against deflate bombs. */
export const SHARE_MAX_DOC_BYTES = 16 * 1024 * 1024;

export interface ShareOptions {
  /** Page that opens the link (default https://circuitsvibe.com/app.html). Any fragment is replaced. */
  baseUrl?: string;
  /** Custom component definitions, if the document uses registered custom types. */
  definitions?: ComponentDefinitions;
}

export interface ShareLink {
  url: string;
  /** Length of `url` in bytes (it is pure ASCII: equal to its character count). */
  bytes: number;
  /** UTF-8 size of the canonical JSON that was compressed. */
  jsonBytes: number;
  /** Non-fatal findings, e.g. T018 (link longer than SHARE_WARN_LENGTH). */
  warnings: Diagnostic[];
}

// ─── base64url (RFC 4648 §5, no padding) ────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Strict decoder: only the base64url alphabet, no padding. Throws on anything else. */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error(`invalid base64url length ${text.length}`);
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? LOOKUP[code] : -1;
    if (v < 0) throw new Error(`invalid base64url character ${JSON.stringify(text[i])} at position ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ─── deflate-raw through the platform streams ────────────────────────────────

function requireStreams(): void {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new Error('share links need CompressionStream/DecompressionStream (any modern browser, Node >= 20.12)');
  }
}

async function pump(bytes: Uint8Array, stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> }, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes as BufferSource).then(() => writer.close());
  writing.catch(() => undefined); // surfaced through the reader
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new SizeLimitError(`decoded size above ${limit} bytes`);
    }
    chunks.push(value);
  }
  await writing;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

class SizeLimitError extends Error {}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  requireStreams();
  return pump(bytes, new CompressionStream('deflate-raw'), Number.MAX_SAFE_INTEGER);
}

async function inflateRaw(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  requireStreams();
  return pump(bytes, new DecompressionStream('deflate-raw'), limit);
}

// ─── encode / decode ─────────────────────────────────────────────────────────

/**
 * Build a share link and report its size. The document is validated,
 * canonicalized and stripped of `at` locations first (meta, layout, sources
 * and overrides are kept). Throws CircuitDocError: T010–T014 (invalid
 * document), T015 (link above SHARE_MAX_LENGTH).
 */
export async function createShareLink(doc: CircuitDoc, opts: ShareOptions = {}): Promise<ShareLink> {
  const checked = validateCircuitDoc(doc, { definitions: opts.definitions });
  if (!checked.ok) throw new CircuitDocError(checked.diagnostics);
  const json = canonicalJson(stripLocations(canonicalizeDoc(checked.doc)));
  const utf8 = new TextEncoder().encode(json);
  const payload = base64UrlEncode(await deflateRaw(utf8));
  const base = (opts.baseUrl ?? DEFAULT_SHARE_BASE_URL).split('#')[0];
  const url = `${base}#c=${SHARE_ENCODING_VERSION}.${payload}`;
  if (url.length > SHARE_MAX_LENGTH) {
    throw new CircuitDocError([
      docDiagnostic('T015', `share link would be ${url.length} characters, above the ${SHARE_MAX_LENGTH}-character cap (browsers refuse longer URLs)`, {
        evidence: { bytes: url.length, jsonBytes: utf8.length, limit: SHARE_MAX_LENGTH },
        fixes: [{ kind: 'share-file', confidence: 'suggested', detail: 'share the .circuit.json file (circuitsvibe export) instead of a link, or drop large embedded sources' }],
      }),
    ]);
  }
  const warnings: Diagnostic[] = [];
  if (url.length > SHARE_WARN_LENGTH) {
    warnings.push(
      docDiagnostic('T018', `share link is ${url.length} characters (over ${SHARE_WARN_LENGTH}); some chat apps and mail clients truncate long links`, {
        severity: 'warning',
        evidence: { bytes: url.length, limit: SHARE_WARN_LENGTH },
        fixes: [{ kind: 'share-file', confidence: 'suggested', detail: 'if the link arrives broken, send the .circuit.json from `circuitsvibe export` instead' }],
      }),
    );
  }
  return { url, bytes: url.length, jsonBytes: utf8.length, warnings };
}

/** `<baseUrl>#c=1.<payload>` for a circuit document (see createShareLink for errors). */
export async function encodeShareUrl(doc: CircuitDoc, opts: ShareOptions = {}): Promise<string> {
  return (await createShareLink(doc, opts)).url;
}

function malformed(message: string, note?: string): CircuitDocError {
  return new CircuitDocError([
    docDiagnostic('T016', message, {
      ...(note ? { note } : {}),
      fixes: [{ kind: 'recopy-link', confidence: 'suggested', detail: 'copy the complete link again (it may have been truncated or altered), or ask for the .circuit.json file' }],
    }),
  ]);
}

/** Extract the `c` payload from a full URL, a `#c=…` fragment, `c=…`, or a bare `1.…` payload. */
function extractPayload(input: string): string {
  const s = input.trim().replace(/^<(.*)>$/s, '$1').trim();
  const hash = s.indexOf('#');
  const fragment = hash >= 0 ? s.slice(hash + 1) : s;
  for (const part of fragment.split('&')) {
    if (part.startsWith('c=')) return part.slice(2);
  }
  if (/^\d+\./.test(fragment)) return fragment;
  throw malformed(hash >= 0 ? `link fragment has no 'c=' circuit payload` : `not a circuit share link: expected '…#c=1.<payload>'`);
}

/**
 * Decode a share link (full URL, `#c=…` fragment or bare payload) back to a
 * validated circuit document. Browser-safe; this is what the web viewer
 * calls on `location.hash`. Throws CircuitDocError: T016 malformed link,
 * T017 unknown encoding version, T015 decoded document too large,
 * T010–T014 invalid document.
 */
export async function decodeShareUrl(input: string, opts: { definitions?: ComponentDefinitions } = {}): Promise<CircuitDoc> {
  if (typeof input !== 'string') throw malformed('share link must be a string');
  if (input.length > SHARE_MAX_LENGTH) {
    throw new CircuitDocError([docDiagnostic('T015', `share link is ${input.length} characters, above the ${SHARE_MAX_LENGTH}-character cap`)]);
  }
  let payload = extractPayload(input);
  if (payload.includes('%')) {
    try {
      payload = decodeURIComponent(payload);
    } catch {
      throw malformed('share link payload has invalid percent-encoding');
    }
  }
  const m = payload.match(/^(\d+)\.(.*)$/s);
  if (!m) throw malformed(`share payload must start with '<version>.' (e.g. '1.')`);
  if (m[1] !== String(SHARE_ENCODING_VERSION)) {
    throw new CircuitDocError([
      docDiagnostic('T017', `share link encoding version ${m[1]} is not supported (this circuitsvibe reads version ${SHARE_ENCODING_VERSION})`, {
        fixes: [{ kind: 'upgrade', confidence: 'suggested', detail: 'upgrade circuitsvibe (npx circuitsvibe@latest open <link>)' }],
      }),
    ]);
  }
  let compressed: Uint8Array;
  try {
    compressed = base64UrlDecode(m[2]);
  } catch (err) {
    throw malformed(`share payload is not base64url: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (compressed.length === 0) throw malformed('share payload is empty');
  let bytes: Uint8Array;
  try {
    bytes = await inflateRaw(compressed, SHARE_MAX_DOC_BYTES);
  } catch (err) {
    if (err instanceof SizeLimitError) {
      throw new CircuitDocError([
        docDiagnostic('T015', `decoded document exceeds ${SHARE_MAX_DOC_BYTES} bytes; refusing to decode further`, { evidence: { limit: SHARE_MAX_DOC_BYTES } }),
      ]);
    }
    throw malformed('share payload is not valid deflate-raw data', 'the link was probably truncated or edited');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw malformed('share payload is not UTF-8 text');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw malformed(`share payload is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = validateCircuitDoc(value, opts);
  if (!checked.ok) throw new CircuitDocError(checked.diagnostics);
  return checked.doc;
}
