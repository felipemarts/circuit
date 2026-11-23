/**
 * Behaviors shared by the landing page and the docs: theme toggle, mobile
 * nav, copy buttons on code blocks, scroll reveal and syntax highlighting.
 */
import { highlightAll } from './highlight';

const THEME_KEY = 'cv-theme';

export function currentTheme(): 'dark' | 'light' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return 'dark';
}

export function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent('cv-theme', { detail: theme }));
}

export function initThemeToggle(): void {
  document.querySelectorAll<HTMLElement>('.theme-toggle').forEach(btn => {
    btn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  });
}

export function initMobileNav(): void {
  const toggle = document.querySelector<HTMLElement>('.nav-toggle');
  const links = document.querySelector<HTMLElement>('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  links.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('a')) links.classList.remove('open');
  });
}

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';
const OK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Text to copy for a code block: shell transcripts drop the `$ ` prompt and output lines. */
function copyTextFor(code: HTMLElement): string {
  const raw = code.textContent ?? '';
  if (code.dataset.lang === 'sh') {
    const cmds = raw.split('\n').filter(l => l.startsWith('$ ')).map(l => l.slice(2).replace(/\s{3,}#.*$/, '').trimEnd());
    if (cmds.length > 0) return cmds.join('\n');
  }
  return raw.replace(/\n$/, '');
}

export function initCopyButtons(labels: { copy: string; copied: string }): void {
  document.querySelectorAll<HTMLElement>('.code[data-copy]').forEach(block => {
    const code = block.querySelector<HTMLElement>('pre code');
    if (!code || block.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.innerHTML = `${COPY_ICON}<span>${labels.copy}</span>`;
    btn.setAttribute('aria-label', labels.copy);
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copyTextFor(code));
        btn.classList.add('ok');
        btn.innerHTML = `${OK_ICON}<span>${labels.copied}</span>`;
        setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = `${COPY_ICON}<span>${labels.copy}</span>`; }, 1600);
      } catch { /* clipboard blocked */ }
    });
    block.appendChild(btn);
  });
}

export function initReveal(): void {
  const els = document.querySelectorAll<HTMLElement>('.reveal');
  if (els.length === 0) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    els.forEach(el => el.classList.add('in'));
    return;
  }
  // Only elements below the fold start hidden; everything is revealed after a
  // safety timeout so nothing can stay invisible (print, odd viewports, etc).
  const vh = window.innerHeight;
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { (e.target as HTMLElement).classList.add('in'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
  els.forEach(el => {
    if (el.getBoundingClientRect().top > vh) { el.classList.add('pre'); io.observe(el); }
    else el.classList.add('in');
  });
  setTimeout(() => els.forEach(el => el.classList.add('in')), 2500);
}

export function initShared(labels: { copy: string; copied: string }): void {
  initThemeToggle();
  initMobileNav();
  highlightAll();
  initCopyButtons(labels);
  initReveal();
}
