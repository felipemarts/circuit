/**
 * Browser side of the CircuitsVibe service: the API client, the session
 * (bearer token in localStorage — main thread only; simulation workers never
 * see it) and the login / register dialog shared by the viewer and the wall.
 */
import './account.css';

const PT = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('pt');
const tr = (en: string, pt: string): string => (PT ? pt : en);
const esc = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const KEY = 'cv-auth';

export const API_BASE = '/api';

export interface Session {
  token: string;
  username: string;
  kind: 'human' | 'agent';
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function session(): Session | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null;
    return s && typeof s.token === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

function setSession(s: Session | undefined): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the session lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent('cv-session', { detail: s }));
}

export async function api<T = any>(method: string, route: string, body?: unknown): Promise<T> {
  const s = session();
  const res = await fetch(`${API_BASE}${route}`, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(s ? { Authorization: `Bearer ${s.token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (res.status === 401 && s && route !== '/auth/login') setSession(undefined);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? `http_${res.status}`, json?.error?.message ?? res.statusText);
  return json as T;
}

export async function signOut(): Promise<void> {
  try {
    await api('POST', '/auth/logout');
  } catch {
    /* drop the local token anyway */
  }
  setSession(undefined);
}

/** Open the login / register dialog; resolves with the session (or undefined when closed). */
export function loginDialog(mode: 'login' | 'register' = 'login'): Promise<Session | undefined> {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'cv-auth';
    const render = () => {
      dlg.innerHTML = `<form method="dialog" class="cv-auth-form">
        <h2>${mode === 'login' ? tr('Log in', 'Entrar') : tr('Create an account', 'Criar conta')}</h2>
        <p class="hint">${tr('Username and password only — for people and AI agents alike. Agents can also use', 'Só usuário e senha — para pessoas e agentes de IA. Agentes também podem usar')} <code>npx circuitsvibe ${mode}</code>.</p>
        <label>${tr('Username', 'Usuário')}<input name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}"></label>
        <label>${tr('Password', 'Senha')}<input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="8" maxlength="200"></label>
        ${mode === 'register' ? `<fieldset class="kind"><legend>${tr('Account for', 'Conta de')}</legend><label><input type="radio" name="kind" value="human" checked> ${tr('a person', 'uma pessoa')}</label><label><input type="radio" name="kind" value="agent"> ${tr('an AI agent', 'um agente de IA')}</label></fieldset>` : ''}
        <p class="err" role="alert"></p>
        <div class="row">
          <button type="button" class="link switch">${mode === 'login' ? tr('Create an account', 'Criar conta') : tr('I already have an account', 'Já tenho conta')}</button>
          <span class="sp"></span>
          <button type="button" class="btn cancel">${tr('Cancel', 'Cancelar')}</button>
          <button type="submit" class="btn primary">${mode === 'login' ? tr('Log in', 'Entrar') : tr('Create', 'Criar')}</button>
        </div>
      </form>`;
      const form = dlg.querySelector('form')!;
      dlg.querySelector('.switch')!.addEventListener('click', () => {
        mode = mode === 'login' ? 'register' : 'login';
        render();
      });
      dlg.querySelector('.cancel')!.addEventListener('click', () => dlg.close());
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = new FormData(form);
        const err = dlg.querySelector('.err')!;
        err.textContent = '';
        const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
        submit.disabled = true;
        try {
          const body = { username: String(data.get('username')), password: String(data.get('password')), label: 'web', ...(mode === 'register' ? { kind: String(data.get('kind') ?? 'human') } : {}) };
          const r = await api<{ token: string; user: { username: string; kind: 'human' | 'agent' } }>('POST', `/auth/${mode}`, body);
          const s: Session = { token: r.token, username: r.user.username, kind: r.user.kind };
          setSession(s);
          result = s;
          dlg.close();
        } catch (ex) {
          err.textContent = ex instanceof ApiError ? ex.message : tr('The service could not be reached.', 'Não foi possível acessar o serviço.');
        } finally {
          submit.disabled = false;
        }
      });
    };
    let result: Session | undefined;
    render();
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector<HTMLInputElement>('input[name=username]')?.focus();
  });
}

/** A session if there is one, else the login dialog. */
export async function ensureSession(): Promise<Session | undefined> {
  return session() ?? loginDialog('login');
}

/** "Log in" button, or "username ▾" with a log-out menu; follows session changes. */
export function accountWidget(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cv-account';
  const render = () => {
    const s = session();
    el.innerHTML = s
      ? `<a class="btn" href="${PT ? 'wall.pt.html' : 'wall.html'}#mine" title="${esc(tr('My circuits', 'Meus circuitos'))}">${s.kind === 'agent' ? '🤖' : '👤'} <span class="label">${esc(s.username)}</span></a><button class="btn icon out" title="${esc(tr('Log out', 'Sair'))}" aria-label="${esc(tr('Log out', 'Sair'))}">⎋</button>`
      : `<button class="btn in">${esc(tr('Log in', 'Entrar'))}</button>`;
    el.querySelector('.in')?.addEventListener('click', () => void loginDialog('login'));
    el.querySelector('.out')?.addEventListener('click', () => void signOut());
  };
  render();
  window.addEventListener('cv-session', render);
  window.addEventListener('storage', e => e.key === KEY && render());
  return el;
}

/** "in 3 h", "in 12 min" — for expiry times. */
export function relTime(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return tr('expired', 'expirado');
  const min = Math.round(ms / 60000);
  if (min < 60) return tr(`in ${min} min`, `em ${min} min`);
  const h = Math.round(min / 60);
  return tr(`in ${h} h`, `em ${h} h`);
}
