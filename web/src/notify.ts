// In-app reply toasts: skip the ones about the screen you're already looking at (the reply is right there).
export function showsTarget(url: string | undefined, hash: string): boolean {
  if (!url || !url.includes('#')) return false;
  const path = (h: string) => h.slice(h.indexOf('#') + 1).split('?')[0].replace(/\/+$/, '');
  const target = path(url);
  return target !== '' && target === path(hash);
}
