/**
 * Service commands of the CLI: accounts (register / login / logout / whoami),
 * sharing through the circuit cache, the public wall (circuits) and the
 * component registry (component publish / search / info / add).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CLI } from '../schema/version';
import type { Diagnostic } from '../schema/types';
import type { ComponentDef } from '../core/CustomComponent';
import type { CircuitDoc, CircuitMeta } from '../doc/types';
import { toCircuitDoc, canonicalizeDoc } from '../doc/convert';
import { validateCircuitDoc } from '../doc/validate';
import { createShareLink } from '../doc/share';
import { CircuitDocError, docDiagnostic, isCircuitDocError } from '../doc/errors';
import { loadCircuit, readDoc, isDocFile, isLink } from './circuit';
import { loadComponentModule, REGISTRY_HEADER_RE } from './load';
import { apiBase, clearCredentials, credentialsPath, readCredentials, request, requireLogin, saveCredentials, token, uploadCircuit, type ServiceCircuit } from './service';

/** The subset of parsed CLI flags these commands read. */
export interface CloudFlags {
  json: boolean;
  force: boolean;
  allowCode: boolean;
  public: boolean;
  link: boolean;
  mine: boolean;
  overrides: Record<string, number>;
  options: Record<string, string>;
  positional: string[];
}

const fail = (message: string, fix?: string): CircuitDocError =>
  new CircuitDocError([docDiagnostic('T020', message, fix ? { fixes: [{ kind: 'usage', confidence: 'suggested', detail: fix }] } : {})]);

export function metaOf(flags: CloudFlags): CircuitMeta {
  const meta: CircuitMeta = {};
  for (const k of ['title', 'description', 'author'] as const) if (flags.options[k]) meta[k] = flags.options[k];
  return meta;
}

// ─── documents ───────────────────────────────────────────────────────────────

/**
 * The circuit document of a CLI input. A bench or a document is elaborated
 * (so --set applies); a document that carries custom-component code is passed
 * through as data when --allow-code is not given (nothing is executed).
 */
export async function docFor(file: string, flags: CloudFlags): Promise<CircuitDoc> {
  const meta = metaOf(flags);
  if (isDocFile(file) || isLink(file)) {
    const { doc } = await readDoc(file);
    const hasCode = Array.isArray((doc as CircuitDoc)?.definitions) && (doc as CircuitDoc).definitions!.length > 0;
    if (hasCode && !flags.allowCode) {
      if (Object.keys(flags.overrides).length > 0) {
        throw new CircuitDocError([docDiagnostic('T019', '--set on a document with custom-component code needs --allow-code (the values are applied by elaborating it)', { fixes: [{ kind: 'allow-code', confidence: 'suggested', detail: 'review the sources, then add --allow-code' }] })]);
      }
      const v = validateCircuitDoc(doc);
      if (!v.ok) throw new CircuitDocError(v.diagnostics);
      const merged = { ...v.doc, ...(Object.keys(meta).length ? { meta: { ...(v.doc.meta ?? {}), ...meta } } : {}) };
      return canonicalizeDoc(merged);
    }
  }
  const loaded = await loadCircuit(file, { allowCode: flags.allowCode });
  return toCircuitDoc(loaded.desc, { ...loaded.overrides, ...flags.overrides }, { meta, definitionSources: loaded.definitionSources });
}

export type ShareOutcome =
  | { url: string; bytes: number; warnings: Diagnostic[]; id?: string; visibility?: 'private' | 'public'; expiresAt?: string | null }
  | { error: { code: string; message: string } };

/**
 * Share a document: logged in (or --public) → the circuit cache (short link,
 * any size; private links expire in 24 h, --public lists it on the wall);
 * otherwise, or with --link, the self-contained #c=1.… link.
 */
export async function shareDoc(doc: CircuitDoc, flags: CloudFlags): Promise<ShareOutcome & { url: string }> {
  const json = JSON.stringify(doc);
  if (!flags.link && (token() || flags.public)) {
    const tags = flags.options.tags ? flags.options.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined;
    const c = await uploadCircuit(doc, { visibility: flags.public ? 'public' : 'private', title: flags.options.title, description: flags.options.description, tags, api: flags.options.api });
    return { url: c.url, bytes: c.size ?? json.length, warnings: [], id: c.id, visibility: c.visibility, expiresAt: c.expiresAt };
  }
  try {
    const link = await createShareLink(doc, { baseUrl: flags.options['base-url'] });
    return { url: link.url, bytes: link.bytes, warnings: link.warnings };
  } catch (err) {
    if (isCircuitDocError(err) && err.code === 'T015') {
      const d = err.diagnostics[0];
      throw new CircuitDocError([{ ...d, fixes: [{ kind: 'login', confidence: 'suggested', detail: `log in (${CLI} login, or ${CLI} register) and share again: the circuit cache gives a short link for a circuit of any size` }, ...d.fixes] }]);
    }
    throw err;
  }
}

export function printShare(s: ShareOutcome, out: (line: string) => void = console.log): void {
  if ('error' in s) {
    out(`share: not available — ${s.error.code} ${s.error.message}`);
    return;
  }
  out(s.url);
  if (s.visibility === 'private') out(`  private link — anyone with it can open the circuit until ${s.expiresAt} (24 h); --public lists it on the wall`);
  if (s.visibility === 'public') out('  public — listed on the wall (circuitsvibe.com/wall.html), searchable, can earn stars');
  for (const w of s.warnings) out(`  warning ${w.code}: ${w.message}`);
}

// ─── accounts ────────────────────────────────────────────────────────────────

async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  process.stderr.write(prompt);
  return new Promise(resolve => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function credentialsFrom(flags: CloudFlags): Promise<{ username: string; password: string }> {
  const username = flags.options.user ?? flags.positional[0];
  if (!username) throw fail('a username is needed', `${CLI} login --user <name> --password <password> (or CIRCUITSVIBE_PASSWORD, or the password on stdin)`);
  const password = flags.options.password || process.env.CIRCUITSVIBE_PASSWORD || (await readSecret('password: '));
  if (!password) throw fail('a password is needed', 'pass --password, set CIRCUITSVIBE_PASSWORD, or pipe it on stdin');
  return { username, password };
}

async function signIn(kind: 'register' | 'login', flags: CloudFlags): Promise<number> {
  const { username, password } = await credentialsFrom(flags);
  const api = apiBase(flags.options.api);
  const body = kind === 'register' ? { username, password, kind: flags.options.kind ?? 'human', label: 'cli' } : { username, password, label: 'cli' };
  const r = await request<{ token: string; user: { username: string; kind: 'human' | 'agent' } }>('POST', `/auth/${kind}`, body, { api, auth: false });
  saveCredentials({ api, token: r.token, username: r.user.username, kind: r.user.kind });
  if (flags.json) console.log(JSON.stringify({ user: r.user, api, credentials: credentialsPath() }, null, 2));
  else console.log(`${kind === 'register' ? 'registered and logged in' : 'logged in'} as ${r.user.username} (${r.user.kind}) — token saved to ${credentialsPath()}`);
  return 0;
}

export const register = (flags: CloudFlags) => signIn('register', flags);
export const login = (flags: CloudFlags) => signIn('login', flags);

export async function logout(flags: CloudFlags): Promise<number> {
  if (readCredentials()) {
    try {
      await request('POST', '/auth/logout');
    } catch {
      /* the local token is dropped anyway */
    }
  }
  clearCredentials();
  if (!flags.json) console.log('logged out');
  return 0;
}

export async function whoami(flags: CloudFlags): Promise<number> {
  requireLogin();
  const me = await request<{ user: { username: string; kind: string }; circuits: number; components: number }>('GET', '/auth/me', undefined, { api: flags.options.api });
  if (flags.json) console.log(JSON.stringify({ ...me, api: apiBase(flags.options.api) }, null, 2));
  else console.log(`${me.user.username} (${me.user.kind}) · ${me.circuits} circuits · ${me.components} components · ${apiBase(flags.options.api)}`);
  return 0;
}

// ─── the wall ────────────────────────────────────────────────────────────────

export async function circuits(flags: CloudFlags): Promise<number> {
  const q = new URLSearchParams();
  if (flags.positional.length) q.set('q', flags.positional.join(' '));
  if (flags.options.sort) q.set('sort', flags.options.sort);
  if (flags.options.tags) q.set('tag', flags.options.tags);
  if (flags.options.user) q.set('author', flags.options.user);
  if (flags.options.page) q.set('page', flags.options.page);
  if (flags.mine) {
    requireLogin();
    q.set('mine', '1');
  }
  const r = await request<{ items: ServiceCircuit[]; total: number; page: number }>('GET', `/circuits?${q}`, undefined, { api: flags.options.api });
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (r.items.length === 0) console.log(flags.mine ? 'no circuits yet' : 'no public circuits match');
  for (const c of r.items) {
    const vis = c.visibility === 'public' ? `★ ${c.stars}` : `private until ${c.expiresAt}`;
    console.log(`${c.id}  ${vis.padEnd(10)} ${c.title}  — ${c.author.username}${c.author.kind === 'agent' ? ' (agent)' : ''} · ${c.components} parts\n            ${c.url}`);
  }
  console.log(`\n${r.total} circuit${r.total === 1 ? '' : 's'} · page ${r.page}${r.total > r.items.length ? ` (--page ${r.page + 1} for more)` : ''}`);
  return 0;
}

// ─── components ──────────────────────────────────────────────────────────────

function definitionOf(v: unknown): ComponentDef | undefined {
  const def = (v as { _componentDef?: ComponentDef } | null | undefined)?._componentDef ?? (v as ComponentDef | null | undefined);
  return def && typeof def === 'object' && typeof def.name === 'string' && Array.isArray(def.pins) && typeof def.stamp === 'function' ? def : undefined;
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

interface ComponentInfo {
  rank?: number;
  ref: string;
  owner: { username: string; kind: string };
  name: string;
  description: string;
  tags: string[];
  latest: number;
  typeName: string;
  pins: string[];
  uses: number;
  circuits: number;
  downloads: number;
  install: string;
  url: string;
  versions?: { version: number; hash: string; createdAt: string }[];
  source?: string;
}

export async function component(flags: CloudFlags): Promise<number> {
  const [sub, ...args] = flags.positional;
  const f = { ...flags, positional: args };
  switch (sub) {
    case 'publish':
      return publishComponent(f);
    case 'search':
    case 'list':
      return searchComponents(f);
    case 'info':
      return componentInfo(f);
    case 'add':
    case 'install':
      return addComponent(f);
    default:
      console.error(`error: component needs a subcommand: publish <file.ts> | search [query] | info <user/name> | add <user/name[@version]>`);
      return 3;
  }
}

async function publishComponent(flags: CloudFlags): Promise<number> {
  const file = flags.positional[0];
  if (!file) throw fail('component publish needs the module file that exports the definition', `${CLI} component publish thermistor.part.ts --description "NTC thermistor, B model"`);
  requireLogin();
  const { exports, sourceOf } = loadComponentModule(file);
  const found = Object.entries(exports).map(([k, v]) => [k, definitionOf(v)] as const).filter((e): e is readonly [string, ComponentDef] => e[1] !== undefined);
  const chosen = flags.options.export ? found.filter(([k]) => k === flags.options.export) : found;
  if (chosen.length !== 1) {
    throw fail(chosen.length === 0 ? `${file} exports no defineComponent definition${flags.options.export ? ` named '${flags.options.export}'` : ''}` : `${file} exports ${chosen.length} definitions (${chosen.map(([k]) => k).join(', ')})`, `export one definition per file (export default defineComponent({...})), or pick one with --export <name>`);
  }
  const [, def] = chosen[0];
  const src = sourceOf(def)!;
  if (src.files.length > 1) throw fail(`${file} imports other local files (${src.files.slice(1).map(f => f.path).join(', ')}): a registry component is one self-contained module`, 'inline the helpers into the component file');
  const source = src.files[0].text.replace(REGISTRY_HEADER_RE, '');
  const name = flags.options.name ?? kebab(def.name);
  const tags = flags.options.tags ? flags.options.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined;
  const r = await request<ComponentInfo & { version: number; hash: string; created: boolean }>('POST', '/components', { name, source, typeName: def.name, pins: def.pins, params: def.params ?? {}, ...(flags.options.description ? { description: flags.options.description } : {}), ...(tags ? { tags } : {}) }, { api: flags.options.api });
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.created ? 'published' : 'unchanged (same source as)'} ${r.ref}@${r.version}  ${r.hash}`);
    console.log(`  install: ${r.install}`);
  }
  return 0;
}

async function searchComponents(flags: CloudFlags): Promise<number> {
  const q = new URLSearchParams();
  if (flags.positional.length) q.set('q', flags.positional.join(' '));
  if (flags.options.sort) q.set('sort', flags.options.sort);
  if (flags.options.user) q.set('author', flags.options.user);
  if (flags.options.page) q.set('page', flags.options.page);
  const r = await request<{ items: ComponentInfo[]; total: number; page: number }>('GET', `/components?${q}`, undefined, { api: flags.options.api });
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (r.items.length === 0) console.log('no components match');
  else console.log(' #  component                         uses  circuits  downloads  latest  pins');
  for (const c of r.items) {
    console.log(`${String(c.rank).padStart(2)}  ${c.ref.padEnd(32)} ${String(c.uses).padStart(5)} ${String(c.circuits).padStart(9)} ${String(c.downloads).padStart(10)}  @${String(c.latest).padEnd(5)} ${c.pins.join(',')}${c.description ? `\n    ${c.description}` : ''}`);
  }
  if (r.items.length) console.log(`\n${r.total} component${r.total === 1 ? '' : 's'} · ranked by distinct users who shared a circuit with them · install: ${CLI} component add <user/name>`);
  return 0;
}

function parseRef(input: string | undefined): { owner: string; name: string; version?: number } {
  const m = input?.match(/^([A-Za-z0-9][A-Za-z0-9_-]{2,31})\/([a-z][a-z0-9-]{1,39})(?:@(\d+))?$/);
  if (!m) throw fail(`expected a component ref <user>/<name>[@version], got ${JSON.stringify(input ?? '')}`, `${CLI} component search to find one`);
  return { owner: m[1], name: m[2], ...(m[3] ? { version: Number(m[3]) } : {}) };
}

async function componentInfo(flags: CloudFlags): Promise<number> {
  const { owner, name } = parseRef(flags.positional[0]);
  const r = await request<ComponentInfo>('GET', `/components/${owner}/${name}`, undefined, { api: flags.options.api });
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  console.log(`${r.ref}@${r.latest} — ${r.typeName} (pins ${r.pins.join(', ')}) by ${r.owner.username}${r.owner.kind === 'agent' ? ' (agent)' : ''}`);
  if (r.description) console.log(`  ${r.description}`);
  console.log(`  uses ${r.uses} · circuits ${r.circuits} · downloads ${r.downloads}${r.tags.length ? ` · tags ${r.tags.join(', ')}` : ''}`);
  for (const v of r.versions ?? []) console.log(`  @${v.version}  ${v.hash}  ${v.createdAt}`);
  console.log(`  install: ${r.install}\n\n── source (@${r.latest}) — this is code; read it before you run it ──\n${r.source}`);
  return 0;
}

async function addComponent(flags: CloudFlags): Promise<number> {
  const { owner, name, version } = parseRef(flags.positional[0]);
  const r = await request<{ ref: string; version: number; hash: string; typeName: string; pins: string[]; source: string }>('GET', `/components/${owner}/${name}/${version ?? 'latest'}`, undefined, { api: flags.options.api });
  if (sha256(r.source) !== r.hash) throw fail(`the source of ${r.ref} does not match its published hash ${r.hash}; refusing to install it`);
  const dir = flags.options.out ?? 'components';
  const file = path.join(dir, `${name}.part.ts`);
  const content = `// @circuitsvibe-component ${r.ref} ${r.hash}\n${r.source}`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content && !flags.force) {
    throw fail(`${file} exists with different content`, 'pass --force to replace it, or -o <dir> to install elsewhere');
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content);
  const importPath = `./${path.relative('.', file).split(path.sep).join('/').replace(/\.ts$/, '')}`;
  if (flags.json) console.log(JSON.stringify({ ref: r.ref, hash: r.hash, file, typeName: r.typeName, pins: r.pins, import: `import ${r.typeName} from '${importPath}';` }, null, 2));
  else {
    console.log(`installed ${r.ref} → ${file}  (${r.hash})`);
    console.log(`  this file is CODE written by ${owner}: read it before you run it.`);
    console.log(`  use it:  import ${r.typeName} from '${importPath}';   // path relative to your bench`);
    console.log(`           const x1 = tb.add('X1', new ${r.typeName}());   // pins: ${r.pins.join(', ')}`);
    console.log('  circuits that use it carry its source and count towards its ranking.');
  }
  return 0;
}
