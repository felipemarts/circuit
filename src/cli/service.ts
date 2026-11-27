/**
 * Client of the CircuitsVibe service (server/api): accounts, the circuit
 * cache (short links, the public wall) and the component registry.
 *
 *   API base   --api URL › CIRCUITSVIBE_API › the saved login's API › https://circuitsvibe.com/api
 *   token      CIRCUITSVIBE_TOKEN › ~/.circuitsvibe/credentials.json (circuitsvibe login)
 *              (directory: CIRCUITSVIBE_CONFIG_DIR)
 *
 * Every failure is a CircuitDocError T020 carrying the service's error code.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CircuitDocError, docDiagnostic } from '../doc/errors';
import type { CircuitDoc } from '../doc/types';

export const DEFAULT_API = 'https://circuitsvibe.com/api';

export interface Credentials {
  api: string;
  token: string;
  username: string;
  kind?: 'human' | 'agent';
}

function configDir(): string {
  return process.env.CIRCUITSVIBE_CONFIG_DIR || path.join(os.homedir(), '.circuitsvibe');
}

export function credentialsPath(): string {
  return path.join(configDir(), 'credentials.json');
}

export function readCredentials(): Credentials | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Credentials;
    return typeof c.token === 'string' && typeof c.api === 'string' ? c : undefined;
  } catch {
    return undefined;
  }
}

export function saveCredentials(c: Credentials): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentialsPath(), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

export function clearCredentials(): void {
  fs.rmSync(credentialsPath(), { force: true });
}

export function apiBase(override?: string): string {
  return (override || process.env.CIRCUITSVIBE_API || readCredentials()?.api || DEFAULT_API).replace(/\/+$/, '');
}

export function token(): string | undefined {
  return process.env.CIRCUITSVIBE_TOKEN || readCredentials()?.token;
}

function serviceError(message: string, evidence: Record<string, unknown> = {}, fix?: string): CircuitDocError {
  return new CircuitDocError([
    docDiagnostic('T020', message, {
      evidence,
      ...(fix ? { fixes: [{ kind: 'service', confidence: 'suggested', detail: fix }] } : {}),
    }),
  ]);
}

export async function request<T = any>(method: string, route: string, body?: unknown, opts: { api?: string; auth?: boolean } = {}): Promise<T> {
  const base = apiBase(opts.api);
  const tok = opts.auth === false ? undefined : token();
  let res: Response;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw serviceError(`cannot reach the CircuitsVibe service at ${base}: ${err instanceof Error ? err.message : String(err)}`, { api: base }, 'check the network, or point --api / CIRCUITSVIBE_API at another server');
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw serviceError(`the service at ${base} answered ${res.status} with something that is not JSON`, { status: res.status, api: base });
  }
  if (!res.ok) {
    const code = json?.error?.code ?? `http_${res.status}`;
    const message = json?.error?.message ?? res.statusText;
    const fix =
      res.status === 401 ? 'log in: circuitsvibe login --user <name> --password <password> (or set CIRCUITSVIBE_TOKEN)' :
      res.status === 404 && route.startsWith('/circuits/') ? 'private links expire after 24 h; ask the author to share it again, or to publish it (--public)' :
      res.status === 429 ? 'rate limited: wait a while and retry' : undefined;
    throw serviceError(`${method} ${route}: ${res.status} ${code} — ${message}`, { status: res.status, code, api: base }, fix);
  }
  return json as T;
}

export function requireLogin(): void {
  if (!token()) {
    throw serviceError('this command needs an account: you are not logged in', {}, 'circuitsvibe register --user <name> --password <password> (agents: --kind agent), or circuitsvibe login; in CI set CIRCUITSVIBE_TOKEN');
  }
}

/** The circuit id of a service link (`…/app.html?c=<id>`, `…/api/circuits/<id>`), or undefined. */
export function circuitIdOf(input: string): string | undefined {
  const m = input.match(/[?&]c=([A-Za-z0-9]{6,16})(?:[&#]|$)/) ?? input.match(/\/api\/circuits\/([A-Za-z0-9]{6,16})(?:[/?#]|$)/);
  return m?.[1];
}

/** The API base that serves a given link (same origin + /api), for links to another deployment. */
export function apiForLink(input: string): string | undefined {
  try {
    const u = new URL(input);
    return `${u.origin}/api`;
  } catch {
    return undefined;
  }
}

export interface ServiceCircuit {
  id: string;
  url: string;
  visibility: 'private' | 'public';
  title: string;
  description: string;
  tags: string[];
  name: string;
  types: string[];
  components: number;
  size: number;
  author: { username: string; kind: 'human' | 'agent' };
  stars: number;
  views: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  starred?: boolean;
  mine?: boolean;
  doc?: CircuitDoc;
}

export async function fetchCircuitDoc(input: string): Promise<{ doc: CircuitDoc; circuit: ServiceCircuit }> {
  const id = circuitIdOf(input)!;
  const api = /^https?:/.test(input) && !process.env.CIRCUITSVIBE_API ? apiForLink(input) : undefined;
  const circuit = await request<ServiceCircuit>('GET', `/circuits/${id}`, undefined, { api });
  return { doc: circuit.doc!, circuit };
}

export async function uploadCircuit(doc: CircuitDoc, opts: { visibility: 'private' | 'public'; title?: string; description?: string; tags?: string[]; api?: string }): Promise<ServiceCircuit> {
  requireLogin();
  return request<ServiceCircuit>('POST', '/circuits', { doc, visibility: opts.visibility, ...(opts.title ? { title: opts.title } : {}), ...(opts.description ? { description: opts.description } : {}), ...(opts.tags ? { tags: opts.tags } : {}) }, { api: opts.api });
}
