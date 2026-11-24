/**
 * Canonical JSON: object keys sorted ascending (UTF-16 code-unit order, i.e.
 * JavaScript's default sort), arrays kept in order, numbers and strings as
 * JSON.stringify writes them (ECMAScript shortest round-trip number form),
 * `undefined` members dropped, no whitespace unless `indent` is given.
 * Equal data ⇒ equal text ⇒ equal share URL.
 */
export function canonicalJson(value: unknown, indent = 0): string {
  return write(value, indent > 0 ? ' '.repeat(indent) : '', '');
}

function write(value: unknown, step: string, pad: string): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number ${value} cannot be represented in JSON`);
    }
    return JSON.stringify(value) ?? 'null';
  }
  const inner = pad + step;
  const open = step ? `\n${inner}` : '';
  const close = step ? `\n${pad}` : '';
  const sep = step ? `,\n${inner}` : ',';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${open}${value.map(v => (v === undefined ? 'null' : write(v, step, inner))).join(sep)}${close}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  const colon = step ? ': ' : ':';
  return `{${open}${keys.map(k => `${JSON.stringify(k)}${colon}${write(obj[k], step, inner)}`).join(sep)}${close}}`;
}
