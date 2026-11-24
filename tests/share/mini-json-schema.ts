/**
 * Minimal JSON Schema (2020-12 subset) validator for the tests — no
 * dependency. Supports exactly the keywords schema/circuit.schema.json uses
 * and throws on any other keyword, so the schema can't silently outgrow it.
 */
type Schema = boolean | Record<string, unknown>;

const KNOWN = new Set([
  '$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'const', 'enum', 'pattern', 'minLength',
  'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'allOf',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
]);

export function validateJsonSchema(root: Schema, value: unknown): string[] {
  const errors: string[] = [];
  check(root, root, value, '', errors);
  return errors;
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      throw new Error(`unsupported type ${type}`);
  }
}

function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) node = (node as Record<string, unknown>)[part];
  if (node === undefined) throw new Error(`dangling $ref ${ref}`);
  return node as Schema;
}

function check(root: Schema, schema: Schema, v: unknown, path: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: not allowed`);
    return;
  }
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`mini validator: unsupported keyword ${k}`);
  const s = schema as Record<string, any>;
  if (s.$ref) check(root, resolve(root, s.$ref), v, path, errors);
  if (s.type && !typeOk(s.type, v)) {
    errors.push(`${path}: expected ${s.type}`);
    return;
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: not in enum`);
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${path}: does not match ${s.pattern}`);
    if (s.minLength !== undefined && [...v].length < s.minLength) errors.push(`${path}: too short`);
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: < minimum`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: > maximum`);
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) errors.push(`${path}: <= exclusiveMinimum`);
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) errors.push(`${path}: >= exclusiveMaximum`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path}: too few items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${path}: too many items`);
    if (s.items !== undefined) v.forEach((x, i) => check(root, s.items, x, `${path}/${i}`, errors));
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj)) errors.push(`${path}: missing ${r}`);
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const [k, x] of Object.entries(obj)) {
      if (k in props) check(root, props[k], x, `${path}/${k}`, errors);
      else if (s.additionalProperties !== undefined) check(root, s.additionalProperties, x, `${path}/${k}`, errors);
    }
  }
  if (s.allOf) for (const sub of s.allOf) check(root, sub, v, path, errors);
  if (s.anyOf && !s.anyOf.some((sub: Schema) => validateSub(root, sub, v))) errors.push(`${path}: matches no anyOf branch`);
  if (s.oneOf) {
    const n = s.oneOf.filter((sub: Schema) => validateSub(root, sub, v)).length;
    if (n !== 1) errors.push(`${path}: matches ${n} oneOf branches (expected 1)`);
  }
}

function validateSub(root: Schema, schema: Schema, v: unknown): boolean {
  const errs: string[] = [];
  check(root, schema, v, '', errs);
  return errs.length === 0;
}
