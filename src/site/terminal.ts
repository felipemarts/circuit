/**
 * Animated terminal. The markup already contains the complete transcript
 * (one `<span class="tl">` per line, commands marked `data-cmd`), so without
 * JavaScript or with reduced motion the full output is simply visible.
 * With motion enabled, command lines are typed character by character and
 * output lines are revealed with short delays; the scenario tabs switch
 * between transcripts and the whole thing loops.
 */

interface Scenario { pane: HTMLElement; lines: HTMLElement[] }

export function initTerminal(root: HTMLElement): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const panes = Array.from(root.querySelectorAll<HTMLElement>('[data-scenario]'));
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('.term-tabs button'));
  const replay = root.querySelector<HTMLButtonElement>('.term-replay');
  if (panes.length === 0) return;

  const scenarios: Scenario[] = panes.map(pane => ({ pane, lines: Array.from(pane.querySelectorAll<HTMLElement>('.tl')) }));
  let active = 0;
  let token = 0;
  let visible = true;

  function showPane(idx: number): void {
    active = idx;
    panes.forEach((p, i) => { p.hidden = i !== idx; });
    tabs.forEach((t, i) => { t.classList.toggle('active', i === idx); t.setAttribute('aria-selected', i === idx ? 'true' : 'false'); });
  }

  function sleep(ms: number, tok: number): Promise<void> {
    return new Promise(resolve => setTimeout(() => resolve(), tok === token ? ms : 0));
  }

  async function play(idx: number): Promise<void> {
    const tok = ++token;
    const sc = scenarios[idx];
    showPane(idx);
    root.classList.add('animating');
    const texts = sc.lines.map(l => l.innerHTML);
    sc.lines.forEach(l => l.classList.remove('shown'));

    for (let i = 0; i < sc.lines.length; i++) {
      if (tok !== token) return;
      const line = sc.lines[i];
      const html = texts[i];
      if (line.dataset.cmd !== undefined) {
        // Type the command: the span structure is `<span class="t-prompt">$ </span><span class="t-cmd">…</span>`
        const cmdEl = line.querySelector<HTMLElement>('.t-cmd');
        const full = cmdEl?.textContent ?? '';
        line.classList.add('shown');
        if (cmdEl) {
          cmdEl.textContent = '';
          const caret = document.createElement('span');
          caret.className = 'caret';
          cmdEl.after(caret);
          await sleep(350, tok);
          for (let c = 0; c < full.length; c++) {
            if (tok !== token) return;
            cmdEl.textContent = full.slice(0, c + 1);
            await sleep(full[c] === ' ' ? 60 : 22 + Math.random() * 30, tok);
          }
          await sleep(420, tok);
          caret.remove();
        }
      } else {
        const text = line.textContent ?? '';
        const isStage = /^\s+[✓✗–]/.test(text);
        const isVerdict = /^(PASS|FAIL|ERROR)/.test(text);
        const isBlank = text.trim() === '';
        await sleep(isBlank ? 60 : isStage ? 420 : isVerdict ? 380 : 150, tok);
        line.innerHTML = html;
        line.classList.add('shown');
      }
    }
    if (tok !== token) return;
    await sleep(5200, tok);
    if (tok !== token) return;
    root.classList.remove('animating');
    const next = (idx + 1) % scenarios.length;
    if (visible && !document.hidden) void play(next);
    else { pending = next; }
  }

  let pending: number | null = null;

  if (reduced) {
    showPane(0);
    tabs.forEach((t, i) => t.addEventListener('click', () => showPane(i)));
    replay?.remove();
    return;
  }

  tabs.forEach((t, i) => t.addEventListener('click', () => void play(i)));
  replay?.addEventListener('click', () => void play(active));

  const resume = () => { if (pending !== null && visible && !document.hidden) { const n = pending; pending = null; void play(n); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      visible = entries.some(e => e.isIntersecting);
      if (visible) resume();
    }, { threshold: 0.2 });
    io.observe(root);
  }

  // Start the first scenario once the terminal scrolls into view
  if ('IntersectionObserver' in window) {
    const once = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { once.disconnect(); void play(0); }
    }, { threshold: 0.25 });
    once.observe(root);
    showPane(0);
    root.classList.add('animating');
  } else {
    void play(0);
  }
}
