// Unified diff parser (git diffs and Hermes inline diffs).
export interface Line { t: ' ' | '+' | '-' | '@'; text: string; a?: number; b?: number }
export interface FileDiff { name: string; lines: Line[] }

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let a = 0, b = 0, header = true; // header: between a file start and its first hunk
  const start = (name: string) => { cur = { name, lines: [] }; files.push(cur); header = true; };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { start(raw.split(' b/').pop() ?? ''); continue; }
    // Hermes inline diffs open with "a/<path> → b/<path>".
    if (/^a\/.* → b\//.test(raw)) { start(raw.split(' → b/').pop()!.replace(/^\/+/, '/')); continue; }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (m) {
      if (!cur) start('');
      a = +m[1]; b = +m[2]; header = false;
      cur!.lines.push({ t: '@', text: raw });
      continue;
    }
    if (header || !cur) {
      if (raw.startsWith('+++ ') && !raw.includes('/dev/null')) { if (!cur) start(''); cur!.name = raw.slice(4).replace(/^b\//, ''); }
      continue;
    }
    const c = raw[0];
    if (c === '+') cur.lines.push({ t: '+', text: raw.slice(1), b: b++ });
    else if (c === '-') cur.lines.push({ t: '-', text: raw.slice(1), a: a++ });
    else if (c === '\\') continue;
    else cur.lines.push({ t: ' ', text: raw.slice(1), a: a++, b: b++ });
  }
  return files.filter(f => f.lines.length);
}

