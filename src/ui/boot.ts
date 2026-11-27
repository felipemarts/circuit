/**
 * app.html entry. A share link (`#c=1.<payload>`) opens the viewer; anything
 * else loads the editor. Both are lazy chunks, so the viewer never pays for
 * the editor code and vice versa. The hash is re-checked on navigation so a
 * link pasted into an open editor tab opens the viewer too.
 */
function hasShareHash(hash: string): boolean {
  const frag = hash.startsWith('#') ? hash.slice(1) : hash;
  return frag.split('&').some(p => p.startsWith('c='));
}

/** `app.html?c=<id>`: a circuit stored by the service (short link). */
function hasCircuitId(): boolean {
  return /^[A-Za-z0-9]{6,16}$/.test(new URLSearchParams(location.search).get('c') ?? '');
}

async function boot(): Promise<void> {
  if (hasShareHash(location.hash) || hasCircuitId()) {
    const { mountViewer } = await import('../view/viewer');
    const root = document.body;
    // The editor markup (and its inline welcome script) is replaced by the viewer.
    for (const child of [...root.children]) if (!(child instanceof HTMLScriptElement)) child.remove();
    await mountViewer(root, location.hash);
    window.addEventListener('hashchange', () => location.reload());
  } else {
    await import('./main');
    window.addEventListener('hashchange', () => {
      if (hasShareHash(location.hash)) location.reload();
    });
  }
}

void boot();
