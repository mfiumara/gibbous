// Dev-server URLs mentioned in tool output ("Local: http://localhost:5173/").
export function findLocalUrls(texts: string[]) {
  const set = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\/?[^\s"'`)]*/g)) set.add(m[0].replace('0.0.0.0', 'localhost'));
  return [...set].slice(-5);
}
