// Five-field cron (minute hour day-of-month month day-of-week) with *, lists, ranges and steps.
// Plus two friendly forms: "every 30m" / "every 2h". Evaluated in local time, once per minute.
function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number) as [number, number?] as [number, number];
    if (hi === undefined) hi = stepS ? max : lo;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) || step < 1 || lo < min || hi > max || lo > hi) throw new Error(`bad cron field "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): (d: Date) => boolean {
  const e = expr.trim();
  const every = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?)$/i.exec(e);
  if (every) {
    const n = Number(every[1]);
    return every[2][0].toLowerCase() === 'h' ? parseCron(`0 */${n} * * *`) : parseCron(`*/${n} * * * *`);
  }
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields: minute hour day month weekday (or "every 30m")');
  const [mi, h, dom, mo, dow] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4].replace(/\b7\b/g, '0'), 0, 6)];
  const domStar = f[2] === '*', dowStar = f[4] === '*';
  return (d: Date) => mi.has(d.getMinutes()) && h.has(d.getHours()) && mo.has(d.getMonth() + 1) &&
    // Classic cron: when both day fields are restricted, either may match.
    (domStar && dowStar ? true : domStar ? dow.has(d.getDay()) : dowStar ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay()));
}

// Next matching minute after `from` (searches up to ~1 year).
export function nextRun(expr: string, from = new Date()) {
  const match = parseCron(expr);
  const d = new Date(from); d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) { d.setMinutes(d.getMinutes() + 1); if (match(d)) return d.getTime(); }
  return undefined;
}

// "30 9 * * 1-5" → "Weekdays at 09:30". Shared with the web app; anything unusual falls back to the expression.
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
export function describeCron(expr: string): string {
  const e = expr.trim();
  if (/^every\s/i.test(e)) return e[0].toUpperCase() + e.slice(1);
  const f = e.split(/\s+/);
  if (f.length !== 5) return e;
  const [m, h, dom, mon, dow] = f;
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours`;
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Hourly at :${m.padStart(2, '0')}`;
  if (!time || mon !== '*') return e;
  if (dom === '*' && dow === '*') return `Every day at ${time}`;
  if (dom === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (dom === '*' && /^[0-7]$/.test(dow)) return `${DAYS[Number(dow) % 7]} at ${time}`;
  if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`;
  return e;
}
