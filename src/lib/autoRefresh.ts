// Production tabs follow newly published builds; Vite handles development HMR.
export function enableAutoRefresh() {
  if (!import.meta.env.PROD) return;
  const current = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
  if (!current) return;
  let checking = false;
  const check = async () => {
    if (checking || document.hidden) return;
    // Let an in-progress budget edit finish before refreshing.
    if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;
    checking = true;
    try {
      const response = await fetch('/', { cache: 'no-store' });
      if (!response.ok) return;
      const html = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = html.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
      if (next && next !== current) {
        // A build may still be being copied into place.
        const asset = await fetch(next, { method: 'HEAD', cache: 'no-store' });
        if (asset.ok) window.location.reload();
      }
    } catch { /* Retry after a temporary tunnel or network outage. */ }
    finally { checking = false; }
  };
  window.setInterval(() => void check(), 5000);
  document.addEventListener('visibilitychange', () => void check());
}
