// Runs at document start on every page (the server's and the connect screen), before any page script. Contract with
// web/src/desktopBridge.ts: window.__gibbousShell, data-shell on <html>, window.gibbousDesktop.post(name, body).
(() => {
  const shell = __SHELL__;
  window.__gibbousShell = shell;
  // <html> may not exist yet: set it as soon as it does (main.tsx applies window.__gibbousShell too).
  const apply = () => { const d = document.documentElement; if (!d) return false; d.dataset.shell = shell.platform; return true; };
  if (!apply()) new MutationObserver((_, o) => { if (apply()) o.disconnect(); }).observe(document, { childList: true });

  const invoke = (cmd, args, opts) => {
    const t = window.__TAURI_INTERNALS__;
    return t ? t.invoke(cmd, args, opts) : Promise.reject(new Error('The Gibbous app bridge is unavailable'));
  };
  // Downloads go through the page so they carry its cookies (works for a remote server too); the app writes the bytes.
  async function download(b) {
    const r = await fetch(b.url, { credentials: 'include' });
    if (!r.ok) throw new Error(`Couldn't download ${b.filename || 'the file'} (${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return invoke('save_download', bytes, { headers: { 'x-filename': encodeURIComponent(b.filename || '') } });
  }
  const post = (name, body) => name === 'download' ? download(body || {}) : invoke('bridge', { name, body: body || {} });
  window.gibbousDesktop = Object.freeze({ post });
})();
