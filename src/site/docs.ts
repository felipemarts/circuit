import './site.css';
import './docs.css';
import { initShared } from './shared';

const lang = document.documentElement.lang.startsWith('pt') ? 'pt' : 'en';
const labels = lang === 'pt' ? { copy: 'copiar', copied: 'copiado' } : { copy: 'copy', copied: 'copied' };

initShared(labels);

// ── Sidebar: active section tracking ─────────────────────────────────────────
const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.docs-nav a[href^="#"]'));
const sections = navLinks
  .map(a => document.getElementById(a.getAttribute('href')!.slice(1)))
  .filter((s): s is HTMLElement => !!s);

function setActive(id: string): void {
  navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
}

if (sections.length > 0) {
  const offset = 96;
  let ticking = false;
  const update = () => {
    ticking = false;
    let current = sections[0].id;
    for (const s of sections) {
      if (s.getBoundingClientRect().top - offset <= 0) current = s.id;
    }
    // At the very bottom, highlight the last section
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = sections[sections.length - 1].id;
    setActive(current);
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}

// ── Sidebar: mobile toggle ───────────────────────────────────────────────────
const sideToggle = document.querySelector<HTMLButtonElement>('.docs-side-toggle');
const side = document.querySelector<HTMLElement>('.docs-side');
if (sideToggle && side) {
  sideToggle.addEventListener('click', () => {
    const open = side.classList.toggle('open');
    sideToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  side.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('a') && window.innerWidth <= 960) side.classList.remove('open');
  });
}

// ── Section filter ───────────────────────────────────────────────────────────
const filter = document.querySelector<HTMLInputElement>('.docs-filter input');
if (filter) {
  const items = Array.from(document.querySelectorAll<HTMLLIElement>('.docs-nav li'));
  const empty = document.querySelector<HTMLElement>('.docs-nav .empty');
  const sectionText = new Map<string, string>();
  for (const s of sections) sectionText.set(s.id, (s.textContent ?? '').toLowerCase());

  const apply = () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    let lastGroup: HTMLLIElement | null = null;
    let groupHasItems = false;
    for (const li of items) {
      if (li.classList.contains('empty')) continue;
      if (li.classList.contains('group')) {
        if (lastGroup) lastGroup.hidden = q !== '' && !groupHasItems;
        lastGroup = li; groupHasItems = false;
        continue;
      }
      const a = li.querySelector('a');
      const id = a?.getAttribute('href')?.slice(1) ?? '';
      const label = (a?.textContent ?? '').toLowerCase();
      const match = q === '' || label.includes(q) || (sectionText.get(id) ?? '').includes(q);
      li.hidden = !match;
      if (match) { shown++; groupHasItems = true; }
    }
    if (lastGroup) lastGroup.hidden = q !== '' && !groupHasItems;
    if (empty) empty.hidden = shown > 0;
    // Also narrow the page to matching sections while filtering
    for (const s of sections) s.hidden = q !== '' && !(sectionText.get(s.id) ?? '').includes(q) && !(document.querySelector(`.docs-nav a[href="#${s.id}"]`)?.textContent ?? '').toLowerCase().includes(q);
  };
  filter.addEventListener('input', apply);
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== filter && !(document.activeElement instanceof HTMLInputElement)) {
      e.preventDefault(); filter.focus();
    }
    if (e.key === 'Escape' && document.activeElement === filter) { filter.value = ''; apply(); filter.blur(); }
  });
}
