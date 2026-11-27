/**
 * Integration tests of the PHP API (server/api) against PHP's built-in server.
 * Runs when `php` (8.1+, pdo_sqlite) is on PATH, or with
 * CIRCUITSVIBE_TEST_PHP_DOCKER=php:8.3-cli (Docker). Skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { phpAvailable, startPhp, repo, type PhpServer } from './php';

const enabled = phpAvailable;

let server: PhpServer | undefined;
let base = '';
const TTL = 3;

async function api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${route}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const doc = (name: string, extra: Record<string, unknown> = {}) => ({
  schema: 'circuitsvibe-circuit/1',
  name,
  components: [
    { id: 'R1', type: 'Resistor', params: { r: 1000 }, pins: { 1: 'n1', 2: 'gnd' } },
    { id: 'V1', type: 'VoltageSource', params: { v: 5 }, pins: { '+': 'n1', '-': 'gnd' } },
  ],
  assertions: [],
  ...extra,
});

describe.skipIf(!enabled)('PHP API (server/api)', () => {
  beforeAll(async () => {
    server = await startPhp({ CIRCUITSVIBE_PRIVATE_TTL: String(TTL) });
    base = server.base;
  }, 60_000);

  afterAll(() => server?.stop());

  let alice = '';
  let bob = '';

  it('health and unknown routes', async () => {
    expect((await api('GET', '/health')).json).toMatchObject({ ok: true, privateTtl: TTL });
    const r = await api('GET', '/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });

  it('register, login, me, logout — username + password only', async () => {
    const reg = await api('POST', '/auth/register', { username: 'alice', password: 'correct horse' });
    expect(reg.status).toBe(201);
    expect(reg.json.token).toMatch(/^cv_[0-9a-f]{48}$/);
    expect((await api('POST', '/auth/register', { username: 'ALICE', password: 'whatever1' })).status).toBe(409);
    expect((await api('POST', '/auth/register', { username: 'x', password: 'whatever1' })).json.error.code).toBe('validation');
    expect((await api('POST', '/auth/register', { username: 'carol', password: 'short' })).status).toBe(422);
    const agent = await api('POST', '/auth/register', { username: 'bob-agent', password: 'agent password', kind: 'agent' });
    expect(agent.json.user).toEqual({ username: 'bob-agent', kind: 'agent' });
    bob = agent.json.token;

    expect((await api('POST', '/auth/login', { username: 'alice', password: 'wrong pass' })).status).toBe(401);
    const login = await api('POST', '/auth/login', { username: 'Alice', password: 'correct horse', label: 'cli' });
    expect(login.status).toBe(200);
    alice = login.json.token;
    expect((await api('GET', '/auth/me', undefined, alice)).json.user.username).toBe('alice');
    expect((await api('GET', '/auth/me')).status).toBe(401);

    const extra = (await api('POST', '/auth/login', { username: 'alice', password: 'correct horse' })).json.token;
    expect((await api('POST', '/auth/logout', undefined, extra)).status).toBe(200);
    expect((await api('GET', '/auth/me', undefined, extra)).status).toBe(401);
    expect((await api('GET', '/auth/me', undefined, alice)).status).toBe(200);
  });

  it('a private circuit: short link, anyone with the link can open it, then it expires', async () => {
    expect((await api('POST', '/circuits', { doc: doc('x') })).status).toBe(401);
    expect((await api('POST', '/circuits', { doc: { schema: 'nope' } }, alice)).json.error.code).toBe('validation');
    const big = doc('big', { sources: [{ path: 'a.ts', language: 'typescript', text: 'x'.repeat(300_000) }] });
    const c = await api('POST', '/circuits', { doc: big }, alice);
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ visibility: 'private', title: 'big', components: 2, author: { username: 'alice' } });
    expect(c.json.url).toMatch(/\/app\.html\?c=[A-Za-z0-9]{10}$/);
    expect(c.json.expiresAt).toBeTruthy();
    const got = await api('GET', `/circuits/${c.json.id}`);
    expect(got.status).toBe(200);
    expect(got.json.doc).toEqual(big);
    expect((await api('GET', '/circuits')).json.items.find((x: any) => x.id === c.json.id)).toBeUndefined();
    expect((await api('GET', '/circuits?mine=1', undefined, alice)).json.items.map((x: any) => x.id)).toContain(c.json.id);
    await new Promise(r => setTimeout(r, (TTL + 1) * 1000));
    expect((await api('GET', `/circuits/${c.json.id}`)).status).toBe(404);
  }, 20_000);

  it('the public wall: search, sort, stars; only the author edits', async () => {
    const a = await api('POST', '/circuits', { doc: doc('led-driver', { meta: { title: 'LED driver', description: '5 V LED with a resistor' } }), visibility: 'public', tags: ['led', 'beginner'] }, alice);
    const b = await api('POST', '/circuits', { doc: doc('rc-filter'), visibility: 'public', title: 'RC low-pass' }, bob);
    expect(a.json).toMatchObject({ visibility: 'public', expiresAt: null, title: 'LED driver', tags: ['led', 'beginner'] });

    const search = await api('GET', '/circuits?q=led%20resistor');
    expect(search.json.items.map((x: any) => x.id)).toEqual([a.json.id]);
    expect((await api('GET', '/circuits?q=bob-agent')).json.items.map((x: any) => x.id)).toEqual([b.json.id]);
    expect((await api('GET', '/circuits?tag=beginner')).json.total).toBe(1);
    expect((await api('GET', '/circuits?q=Resistor')).json.total).toBe(2); // component types are searchable

    expect((await api('PUT', `/circuits/${b.json.id}/star`, undefined, alice)).json).toMatchObject({ stars: 1, starred: true });
    expect((await api('PUT', `/circuits/${b.json.id}/star`, undefined, alice)).json.stars).toBe(1); // idempotent
    expect((await api('GET', '/circuits')).json.items[0].id).toBe(b.json.id); // most stars first
    expect((await api('GET', '/circuits?sort=recent')).json.items[0].id).toBe(b.json.id);
    expect((await api('DELETE', `/circuits/${b.json.id}/star`, undefined, alice)).json.stars).toBe(0);

    expect((await api('PATCH', `/circuits/${a.json.id}`, { title: 'hijack' }, bob)).status).toBe(403);
    const priv = await api('PATCH', `/circuits/${a.json.id}`, { visibility: 'private' }, alice);
    expect(priv.json.expiresAt).toBeTruthy();
    expect((await api('PUT', `/circuits/${a.json.id}/star`, undefined, bob)).status).toBe(409);
    expect((await api('DELETE', `/circuits/${a.json.id}`, undefined, bob)).status).toBe(403);
    expect((await api('DELETE', `/circuits/${a.json.id}`, undefined, alice)).status).toBe(200);
  });

  it('components: immutable versions by hash, ranking by distinct users', async () => {
    const source = `import { defineComponent } from 'circuitsvibe';\nexport default defineComponent({ name: 'Ntc', pins: ['1', '2'], stamp(ctx) { ctx.stampResistance('1', '2', 1e4); } });\n`;
    const pub = await api('POST', '/components', { name: 'ntc', source, typeName: 'Ntc', pins: ['1', '2'], description: 'NTC thermistor', tags: ['sensor'] }, alice);
    expect(pub.status).toBe(201);
    expect(pub.json).toMatchObject({ ref: 'alice/ntc', version: 1, created: true, install: 'npx circuitsvibe component add alice/ntc' });
    expect(pub.json.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await api('POST', '/components', { name: 'ntc', source, typeName: 'Ntc', pins: ['1', '2'] }, alice)).json).toMatchObject({ version: 1, created: false });
    expect((await api('POST', '/components', { name: 'ntc', source: source + '// v2\n', typeName: 'Ntc', pins: ['1', '2'] }, alice)).json.version).toBe(2);
    expect((await api('POST', '/components', { name: 'Bad Name', source, typeName: 'Ntc', pins: ['1'] }, alice)).status).toBe(422);
    await api('POST', '/components', { name: 'h-bridge', source: source.replace('Ntc', 'HBridge'), typeName: 'HBridge', pins: ['1', '2'] }, bob);

    const v1 = await api('GET', '/components/alice/ntc/1');
    expect(v1.json).toMatchObject({ ref: 'alice/ntc@1', source, typeName: 'Ntc', pins: ['1', '2'] });
    const info = await api('GET', '/components/alice/ntc');
    expect(info.json.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(info.json.downloads).toBe(1);

    // Usage: circuits that reference registry components (doc.definitions[].registry.ref).
    const uses = (ref: string) => doc('uses', { definitions: [{ type: 'Ntc', pins: ['1', '2'], source: 'ntc.part.ts', registry: { ref, hash: pub.json.hash } }] });
    await api('POST', '/circuits', { doc: uses('alice/ntc@1') }, bob);
    await api('POST', '/circuits', { doc: uses('alice/ntc@2') }, bob); // same user again: still 1 use
    await api('POST', '/circuits', { doc: uses('alice/ntc@2') }, alice);
    const ranking = await api('GET', '/components');
    expect(ranking.json.items.map((c: any) => [c.rank, c.ref, c.uses])).toEqual([[1, 'alice/ntc', 2], [2, 'bob-agent/h-bridge', 0]]);
    expect(ranking.json.items[0].circuits).toBe(3);
    expect((await api('GET', '/components?q=sensor')).json.items.map((c: any) => c.ref)).toEqual(['alice/ntc']);
    expect((await api('GET', '/users/alice')).json).toMatchObject({ components: 1, componentUses: 2 });
  });

  it('rejects malformed bodies and rate-limits failed logins', async () => {
    expect((await api('POST', '/circuits', 'not json', alice)).json.error.code).toBe('bad_json');
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await api('POST', '/auth/login', { username: 'bob-agent', password: `nope${i}xyz` })).status;
    expect(last).toBe(429);
  });

  it('never serves the database or the PHP sources', async () => {
    for (const p of ['/api/data/circuitsvibe.sqlite', '/api/lib/db.php', '/api/config.php']) {
      const r = await fetch(`${base}${p}`);
      expect(await r.text()).not.toMatch(/SQLite format|<\?php|password_hash/);
    }
  });
});
