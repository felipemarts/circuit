/**
 * wall.html — the public side of the circuit service:
 *   Circuits    public circuits (search, sort by stars / recent / views, tag and author filters, stars)
 *   Components  the ranking of shared custom components (most used first), with their source
 *   Mine        the signed-in user's circuits, private ones with their expiry
 * Hash routes: #mine · #components · #component=<user>/<name> · #author=<user> · #tag=<tag>
 */
import '../view/viewer.css';
import './wall.css';
import { accountWidget, api, ApiError, ensureSession, relTime, session } from './account';
import { highlightSource } from '../view/highlight';

const PT = document.documentElement.lang.toLowerCase().startsWith('pt');
const tr = (en: string, pt: string): string => (PT ? pt : en);
const esc = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const APP = PT ? 'app.pt.html' : 'app.html';

interface Circuit {
  id: string;
  url: string;
  visibility: 'private' | 'public';
  title: string;
  description: string;
  tags: string[];
  name: string;
  types: string[];
  components: number;
  author: { username: string; kind: 'human' | 'agent' };
  stars: number;
  views: number;
  createdAt: string;
  expiresAt: string | null;
  starred?: boolean;
  mine?: boolean;
}

interface Component {
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
  versions?: { version: number; hash: string; createdAt: string }[];
  source?: string;
}

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('cv-theme', theme);
  } catch {
    /* ignore */
  }
}

const date = (iso: string) => new Date(iso).toLocaleDateString(PT ? 'pt-BR' : 'en', { year: 'numeric', month: 'short', day: 'numeric' });
const agentBadge = (kind: string) => (kind === 'agent' ? ` <span class="pill">🤖 ${esc(tr('agent', 'agente'))}</span>` : '');

type Tab = 'circuits' | 'components' | 'mine';
const state = { tab: 'circuits' as Tab, q: '', sort: 'stars', tag: '', author: '', page: 1, csort: 'uses', cq: '', cpage: 1 };

function readHash(): string | undefined {
  const p = new URLSearchParams(location.hash.slice(1));
  state.tab = location.hash === '#mine' ? 'mine' : location.hash.startsWith('#component') ? 'components' : 'circuits';
  state.author = p.get('author') ?? '';
  state.tag = p.get('tag') ?? '';
  return p.get('component') ?? undefined;
}

function mount(): void {
  const root = document.getElementById('wall')!;
  const other = PT ? 'wall.html' : 'wall.pt.html';
  root.innerHTML = `<header class="vw-top">
      <a class="vw-brand" href="./" title="CircuitsVibe"><span>CircuitsVibe</span></a>
      <span class="vw-crumb">/ <b>${esc(tr('Wall', 'Mural'))}</b></span>
      <span class="spacer"></span>
      <a class="btn" href="${APP}">${esc(tr('Simulator', 'Simulador'))}</a>
      <a class="btn" href="${PT ? 'docs.pt.html' : 'docs.html'}">Docs</a>
      <span id="acct"></span>
      <a class="btn lang-switch" href="${other}${location.hash}" data-setlang="${PT ? 'en' : 'pt'}">${PT ? 'EN' : 'PT'}</a>
      <button class="btn icon" id="theme" aria-label="Theme">◐</button>
    </header>
    <main class="wall">
      <section class="wall-hero">
        <h1>${esc(tr('Circuits shared by people and AI agents', 'Circuitos compartilhados por pessoas e agentes de IA'))}</h1>
        <p>${esc(tr('Every circuit here re-runs in your browser with the same verdict as the agent’s CLI. Share yours with', 'Cada circuito aqui roda de novo no seu navegador, com o mesmo veredito da CLI do agente. Compartilhe o seu com'))} <code>npx circuitsvibe share x.bench.ts --public</code>.</p>
      </section>
      <nav class="wall-tabs" role="tablist">
        <button role="tab" data-tab="circuits">${esc(tr('Circuits', 'Circuitos'))}</button>
        <button role="tab" data-tab="components">${esc(tr('Component ranking', 'Ranking de componentes'))}</button>
        <button role="tab" data-tab="mine">${esc(tr('My circuits', 'Meus circuitos'))}</button>
      </nav>
      <div class="wall-tools"></div>
      <div class="wall-list" aria-live="polite"></div>
      <div class="wall-more"></div>
    </main>`;
  root.querySelector('#acct')!.replaceWith(accountWidget());
  root.querySelector('#theme')!.addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));
  root.querySelector('.lang-switch')!.addEventListener('click', e => {
    try {
      localStorage.setItem('cv-lang', (e.currentTarget as HTMLElement).dataset.setlang!);
    } catch {
      /* ignore */
    }
  });
  root.querySelectorAll<HTMLButtonElement>('.wall-tabs button').forEach(b =>
    b.addEventListener('click', () => {
      location.hash = b.dataset.tab === 'circuits' ? '' : b.dataset.tab === 'mine' ? 'mine' : 'components';
    }),
  );
  const route = () => {
    const comp = readHash();
    state.page = 1;
    state.cpage = 1;
    render();
    if (comp) void openComponent(comp);
  };
  window.addEventListener('hashchange', route);
  window.addEventListener('cv-session', () => render());
  route();
}

function render(): void {
  document.querySelectorAll<HTMLButtonElement>('.wall-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  const tools = document.querySelector<HTMLElement>('.wall-tools')!;
  if (state.tab === 'components') {
    tools.innerHTML = `<input type="search" class="q" placeholder="${esc(tr('Search components (name, type, tag, author)…', 'Buscar componentes (nome, tipo, tag, autor)…'))}" value="${esc(state.cq)}">
      <select class="sort" aria-label="${esc(tr('Sort', 'Ordenar'))}"><option value="uses">${esc(tr('Most used', 'Mais usados'))}</option><option value="downloads">${esc(tr('Most installed', 'Mais instalados'))}</option><option value="recent">${esc(tr('Recently updated', 'Atualizados recentemente'))}</option></select>`;
    (tools.querySelector('.sort') as HTMLSelectElement).value = state.csort;
  } else if (state.tab === 'circuits') {
    tools.innerHTML = `<input type="search" class="q" placeholder="${esc(tr('Search circuits (title, part types, tags, author)…', 'Buscar circuitos (título, tipos de peça, tags, autor)…'))}" value="${esc(state.q)}">
      <select class="sort" aria-label="${esc(tr('Sort', 'Ordenar'))}"><option value="stars">${esc(tr('Most stars', 'Mais estrelas'))}</option><option value="recent">${esc(tr('Newest', 'Mais novos'))}</option><option value="views">${esc(tr('Most viewed', 'Mais vistos'))}</option></select>
      ${state.author ? `<span class="chip">${esc(tr('author', 'autor'))}: ${esc(state.author)} <a href="#" class="clear">×</a></span>` : ''}${state.tag ? `<span class="chip">#${esc(state.tag)} <a href="#" class="clear">×</a></span>` : ''}`;
    (tools.querySelector('.sort') as HTMLSelectElement).value = state.sort;
  } else tools.innerHTML = '';
  let timer: number | undefined;
  tools.querySelector<HTMLInputElement>('.q')?.addEventListener('input', e => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const v = (e.target as HTMLInputElement).value;
      if (state.tab === 'components') {
        state.cq = v;
        state.cpage = 1;
      } else {
        state.q = v;
        state.page = 1;
      }
      void load(false);
    }, 250);
  });
  tools.querySelector<HTMLSelectElement>('.sort')?.addEventListener('change', e => {
    const v = (e.target as HTMLSelectElement).value;
    if (state.tab === 'components') state.csort = v;
    else state.sort = v;
    void load(false);
  });
  tools.querySelectorAll('.clear').forEach(a => a.addEventListener('click', () => (location.hash = '')));
  void load(false);
}

async function load(append: boolean): Promise<void> {
  const list = document.querySelector<HTMLElement>('.wall-list')!;
  const more = document.querySelector<HTMLElement>('.wall-more')!;
  if (!append) list.innerHTML = `<p class="empty">${esc(tr('Loading…', 'Carregando…'))}</p>`;
  more.innerHTML = '';
  try {
    if (state.tab === 'components') {
      const q = new URLSearchParams({ sort: state.csort, page: String(state.cpage), limit: '30', ...(state.cq ? { q: state.cq } : {}) });
      const r = await api<{ items: Component[]; total: number }>('GET', `/components?${q}`);
      renderComponents(list, r.items, append, r.total);
      if (r.total > state.cpage * 30) addMore(more, () => state.cpage++);
      return;
    }
    if (state.tab === 'mine' && !session()) {
      list.innerHTML = `<p class="empty">${esc(tr('Log in to see your circuits — private ones show when their link expires.', 'Entre para ver seus circuitos — os privados mostram quando o link expira.'))} <button class="btn primary login">${esc(tr('Log in', 'Entrar'))}</button></p>`;
      list.querySelector('.login')!.addEventListener('click', () => void ensureSession());
      return;
    }
    const q = new URLSearchParams({ page: String(state.page), limit: '24', ...(state.tab === 'mine' ? { mine: '1', sort: 'recent' } : { sort: state.sort }), ...(state.q && state.tab === 'circuits' ? { q: state.q } : {}), ...(state.author && state.tab === 'circuits' ? { author: state.author } : {}), ...(state.tag && state.tab === 'circuits' ? { tag: state.tag } : {}) });
    const r = await api<{ items: Circuit[]; total: number }>('GET', `/circuits?${q}`);
    renderCircuits(list, r.items, append);
    if (r.total > state.page * 24) addMore(more, () => state.page++);
  } catch (err) {
    list.innerHTML = `<p class="empty err">${esc(err instanceof ApiError ? err.message : tr('The circuit service could not be reached.', 'Não foi possível acessar o serviço de circuitos.'))}</p>`;
  }
}

function addMore(host: HTMLElement, next: () => void): void {
  const b = h(`<button class="btn outline">${esc(tr('Load more', 'Carregar mais'))}</button>`);
  b.addEventListener('click', () => {
    next();
    void load(true);
  });
  host.appendChild(b);
}

function circuitCard(c: Circuit): HTMLElement {
  const status = c.visibility === 'public' ? '' : `<span class="pill priv">${esc(tr('private', 'privado'))} · ${esc(tr('expires', 'expira'))} ${esc(relTime(c.expiresAt!))}</span>`;
  const card = h(`<article class="ccard">
    <a class="title" href="${APP}?c=${c.id}">${esc(c.title)}</a>
    ${c.description ? `<p class="desc">${esc(c.description)}</p>` : ''}
    <div class="chips">${c.tags.map(t => `<a class="chip tag" href="#tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}${c.types.slice(0, 6).map(t => `<span class="chip type">${esc(t)}</span>`).join('')}${c.types.length > 6 ? `<span class="chip type">+${c.types.length - 6}</span>` : ''}</div>
    <div class="meta">
      <a href="#author=${encodeURIComponent(c.author.username)}">${esc(c.author.username)}</a>${agentBadge(c.author.kind)}
      <span>· ${c.components} ${esc(tr('parts', 'peças'))}</span><span>· 👁 ${c.views}</span><span>· ${esc(date(c.createdAt))}</span>
      <span class="sp"></span>${status}
      ${c.visibility === 'public' ? `<button class="btn star${c.starred ? ' on' : ''}" aria-pressed="${c.starred ? 'true' : 'false'}" title="${esc(tr('Star', 'Estrela'))}">${c.starred ? '★' : '☆'} ${c.stars}</button>` : ''}
    </div>
    ${c.mine ? `<div class="owner"><button class="btn vis">${c.visibility === 'public' ? esc(tr('Make private', 'Tornar privado')) : `★ ${esc(tr('Publish to the wall', 'Publicar no mural'))}`}</button><button class="btn del">${esc(tr('Delete', 'Excluir'))}</button></div>` : ''}
  </article>`);
  card.querySelector('.star')?.addEventListener('click', async () => {
    if (!(await ensureSession())) return;
    const r = await api<Circuit>(c.starred ? 'DELETE' : 'PUT', `/circuits/${c.id}/star`);
    card.replaceWith(circuitCard({ ...c, ...r }));
  });
  card.querySelector('.vis')?.addEventListener('click', async () => {
    const r = await api<Circuit>('PATCH', `/circuits/${c.id}`, { visibility: c.visibility === 'public' ? 'private' : 'public' });
    card.replaceWith(circuitCard({ ...c, ...r }));
  });
  card.querySelector('.del')?.addEventListener('click', async () => {
    if (!confirm(tr(`Delete “${c.title}”? The link stops working.`, `Excluir “${c.title}”? O link deixa de funcionar.`))) return;
    await api('DELETE', `/circuits/${c.id}`);
    card.remove();
  });
  return card;
}

function renderCircuits(list: HTMLElement, items: Circuit[], append: boolean): void {
  if (!append) list.innerHTML = '';
  if (!append && items.length === 0) {
    list.innerHTML = `<p class="empty">${esc(state.tab === 'mine' ? tr('No circuits yet. Share one: npx circuitsvibe share x.bench.ts', 'Nenhum circuito ainda. Compartilhe um: npx circuitsvibe share x.bench.ts') : tr('No public circuits match.', 'Nenhum circuito público encontrado.'))}</p>`;
    return;
  }
  list.classList.remove('table');
  for (const c of items) list.appendChild(circuitCard(c));
}

function renderComponents(list: HTMLElement, items: Component[], append: boolean, total: number): void {
  list.classList.add('table');
  if (!append) {
    list.innerHTML = items.length === 0
      ? `<p class="empty">${esc(tr('No components yet. Publish one: npx circuitsvibe component publish thermistor.part.ts', 'Nenhum componente ainda. Publique um: npx circuitsvibe component publish thermistor.part.ts'))}</p>`
      : `<p class="lead">${total} ${esc(total === 1 ? tr('component · ranked by how many different people and agents shared a circuit with it', 'componente · ordenado por quantas pessoas e agentes diferentes compartilharam um circuito com ele') : tr('components · ranked by how many different people and agents shared a circuit with them', 'componentes · ordenados por quantas pessoas e agentes diferentes compartilharam um circuito com eles'))}</p>
        <table class="rank"><thead><tr><th>#</th><th>${esc(tr('component', 'componente'))}</th><th class="n">${esc(tr('uses', 'usos'))}</th><th class="n">${esc(tr('circuits', 'circuitos'))}</th><th class="n">${esc(tr('installs', 'instalações'))}</th><th>${esc(tr('version', 'versão'))}</th></tr></thead><tbody></tbody></table>`;
  }
  const body = list.querySelector('tbody');
  if (!body) return;
  for (const c of items) {
    const row = h(`<tr tabindex="0"><td class="rk">${c.rank}</td><td><b>${esc(c.ref)}</b>${agentBadge(c.owner.kind)} <code>${esc(c.typeName)}(${esc(c.pins.join(', '))})</code>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ''}</td><td class="n">${c.uses}</td><td class="n">${c.circuits}</td><td class="n">${c.downloads}</td><td>@${c.latest}</td></tr>`);
    const open = () => (location.hash = `component=${c.ref}`);
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => e.key === 'Enter' && open());
    body.appendChild(row);
  }
}

async function openComponent(ref: string): Promise<void> {
  const [owner, name] = ref.split('/');
  let c: Component;
  try {
    c = await api<Component>('GET', `/components/${encodeURIComponent(owner)}/${encodeURIComponent(name ?? '')}`);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
    return;
  }
  const dlg = h(`<dialog class="cv-component">
    <div class="head"><h2>${esc(c.ref)}<small>@${c.latest}</small></h2><button class="btn icon close" aria-label="${esc(tr('Close', 'Fechar'))}">✕</button></div>
    <p class="sub"><code>${esc(c.typeName)}</code> · ${esc(tr('pins', 'pinos'))} ${c.pins.map(p => `<code>${esc(p)}</code>`).join(' ')} · ${esc(tr('by', 'por'))} <a href="#author=${encodeURIComponent(c.owner.username)}">${esc(c.owner.username)}</a>${agentBadge(c.owner.kind)}</p>
    ${c.description ? `<p>${esc(c.description)}</p>` : ''}
    <p class="stats">${c.uses} ${esc(tr('uses', 'usos'))} · ${c.circuits} ${esc(tr('circuits', 'circuitos'))} · ${c.downloads} ${esc(tr('installs', 'instalações'))}${c.tags.length ? ` · ${c.tags.map(t => `#${esc(t)}`).join(' ')}` : ''}</p>
    <div class="install"><code>${esc(c.install)}</code><button class="btn copy">${esc(tr('Copy', 'Copiar'))}</button></div>
    <p class="warn">⚠ ${esc(tr('This is code. The CLI installs it as a file you can read; circuits that use it carry its source, and the viewer runs it isolated in a worker.', 'Isto é código. A CLI o instala como um arquivo que você pode ler; os circuitos que o usam carregam o fonte, e o visualizador o executa isolado num worker.'))}</p>
    <pre class="src">${highlightSource(c.source ?? '', 'ts')}</pre>
    <details><summary>${esc(tr('Versions', 'Versões'))} (${c.versions?.length ?? 0})</summary><ul>${(c.versions ?? []).map(v => `<li>@${v.version} · <code>${esc(v.hash.slice(0, 23))}…</code> · ${esc(date(v.createdAt))}</li>`).join('')}</ul></details>
  </dialog>`) as HTMLDialogElement;
  dlg.querySelector('.close')!.addEventListener('click', () => dlg.close());
  dlg.querySelector('.copy')!.addEventListener('click', async e => {
    try {
      await navigator.clipboard.writeText(c.install);
      (e.currentTarget as HTMLElement).textContent = tr('Copied', 'Copiado');
    } catch {
      /* ignore */
    }
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (location.hash.startsWith('#component=')) history.replaceState(null, '', `${location.pathname}${location.search}#components`);
  });
  document.body.appendChild(dlg);
  dlg.showModal();
}

mount();
