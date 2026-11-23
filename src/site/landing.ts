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
