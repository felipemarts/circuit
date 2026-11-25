import './site.css';
import './landing.css';
import { initShared } from './shared';
import { initHero } from './hero';
import { initTerminal } from './terminal';

const lang = document.documentElement.lang.startsWith('pt') ? 'pt' : 'en';
const labels = lang === 'pt' ? { copy: 'copiar', copied: 'copiado' } : { copy: 'copy', copied: 'copied' };

initShared(labels);

const heroCanvas = document.getElementById('heroCircuit') as HTMLCanvasElement | null;
if (heroCanvas) {
  initHero(heroCanvas, {
    v1: document.getElementById('ro-v1'),
    i: document.getElementById('ro-i'),
    vf: document.getElementById('ro-vf'),
    vr: document.getElementById('ro-vr'),
  });
}

document.querySelectorAll<HTMLElement>('.term[data-animate]').forEach(initTerminal);

/**
 * Gallery filter: a row of family buttons (hidden until JS runs — the grid
 * shows every card without it) toggles `hidden` on the cards whose
 * data-family does not match. Purely cosmetic: no state is persisted.
 */
function initGalleryFilter(): void {
  const row = document.querySelector<HTMLElement>('.gal-filters');
  const grid = document.querySelector<HTMLElement>('.gallery[data-filterable]');
  if (!row || !grid) return;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>('[data-family]'));
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button[data-filter]'));
  const count = row.querySelector<HTMLElement>('.gal-count');
  const countLabel = lang === 'pt' ? (n: number) => `${n} de ${cards.length}` : (n: number) => `${n} of ${cards.length}`;

  function apply(family: string): void {
    let shown = 0;
    for (const card of cards) {
      const show = family === 'all' || card.dataset.family === family;
      card.hidden = !show;
      if (show) shown++;
    }
    for (const b of buttons) {
      const on = b.dataset.filter === family;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (count) count.textContent = countLabel(shown);
  }

  for (const b of buttons) b.addEventListener('click', () => apply(b.dataset.filter ?? 'all'));
  row.hidden = false;
  apply('all');
}

initGalleryFilter();

/** Big "copy the prompt" buttons: copy the text of the element named by data-copy-from. */
function initCopyFrom(): void {
  document.querySelectorAll<HTMLButtonElement>('button[data-copy-from]').forEach(btn => {
    const source = document.querySelector<HTMLElement>(btn.dataset.copyFrom ?? '');
    const label = btn.querySelector('span');
    if (!source || !label) return;
    const idle = label.textContent ?? '';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText((source.textContent ?? '').replace(/\n$/, ''));
        label.textContent = btn.dataset.copied ?? idle;
        setTimeout(() => { label.textContent = idle; }, 1800);
      } catch { /* clipboard blocked */ }
    });
  });
}

initCopyFrom();
