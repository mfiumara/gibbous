// Pace, like CodexBar: compare how much of a window is used with how much of it has gone by. Ahead of the clock =
// "in deficit" (you'd run out before the reset at this rate), behind it = "in reserve".
export interface Pace { delta: number; runsOutIn: number | null }   // delta: elapsed% − used% (positive = reserve); ms
export function pace(usedPercent: number | null, resetAt: number | null, windowSeconds: number | null, now = Date.now()): Pace | null {
  if (usedPercent == null || resetAt == null || !windowSeconds) return null;
  const len = windowSeconds * 1000, left = Math.max(0, resetAt - now), gone = Math.min(len, Math.max(0, len - left));
  if (gone < len * 0.02) return null;   // the window just started: too early to say
  const elapsed = gone / len * 100, delta = elapsed - usedPercent;
  // At the pace so far, when would it hit 100%? Only worth saying when that's before the reset.
  const rate = usedPercent / gone, runsOutIn = rate > 0 ? (100 - usedPercent) / rate : null;
  return { delta, runsOutIn: runsOutIn != null && runsOutIn < left ? runsOutIn : null };
}
