// Agent turns for the demo, picked by prompt. Each one streams like a real Hermes turn: reasoning, status, tool
// calls (real file edits in the session cwd, so diffs are genuine), subagents, approvals and a streamed reply.
import type { Script, Session } from './fake-hermes.ts';

const ok = (output: string) => ({ output, exit_code: 0 });

const SLIDING = `import type { Decision, Limiter, Store } from './limiter.js';
import { MemoryStore } from './stores/memory.js';

export interface SlidingWindowOptions {
  /** Hits allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  store?: Store<Window>;
}

/** Counts for the current and the previous fixed window. */
interface Window { start: number; current: number; previous: number }

/**
 * Sliding-window counter: weights the previous window by how much of it still overlaps the
 * sliding window, so a burst at a window boundary can't double the limit.
 */
export class SlidingWindow implements Limiter {
  private readonly store: Store<Window>;

  constructor(private readonly opts: SlidingWindowOptions) {
    if (opts.limit <= 0) throw new RangeError('limit must be positive');
    if (opts.windowMs <= 0) throw new RangeError('windowMs must be positive');
    this.store = opts.store ?? new MemoryStore<Window>();
  }

  async hit(key: string, now = Date.now()): Promise<Decision> {
    const { limit, windowMs } = this.opts;
    const start = now - (now % windowMs);
    let w = (await this.store.get(key)) ?? { start, current: 0, previous: 0 };
    if (w.start !== start) {
      // Rolled over: the old current window becomes previous (or nothing, if we skipped one).
      w = { start, current: 0, previous: start - w.start === windowMs ? w.current : 0 };
    }
    const overlap = 1 - (now - start) / windowMs;
    const used = w.previous * overlap + w.current;
    const allowed = used + 1 <= limit;
    if (allowed) w.current++;
    await this.store.set(key, w, windowMs * 2);
    const remaining = Math.max(0, Math.floor(limit - used - (allowed ? 1 : 0)));
    return {
      allowed,
      remaining,
      retryAfterMs: allowed ? 0 : Math.ceil(((used + 1 - limit) / Math.max(w.previous, 1)) * windowMs),
      resetAt: start + windowMs * 2,
    };
  }

  reset(key: string) {
    return this.store.delete(key);
  }
}
`;

const SLIDING_TEST = `import { describe, expect, it } from 'vitest';
import { SlidingWindow } from '../src/sliding-window.js';

describe('SlidingWindow', () => {
  it('allows up to the limit inside one window', async () => {
    const w = new SlidingWindow({ limit: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) expect((await w.hit('k', 100)).allowed).toBe(true);
    expect((await w.hit('k', 200)).allowed).toBe(false);
  });

  it('does not double the limit across a window boundary', async () => {
    const w = new SlidingWindow({ limit: 4, windowMs: 1000 });
    for (let i = 0; i < 4; i++) await w.hit('k', 990);
    // 10ms into the next window, ~99% of the previous one still counts.
    expect((await w.hit('k', 1010)).allowed).toBe(false);
  });

  it('frees capacity as the previous window slides out', async () => {
    const w = new SlidingWindow({ limit: 4, windowMs: 1000 });
    for (let i = 0; i < 4; i++) await w.hit('k', 990);
    expect((await w.hit('k', 1600)).allowed).toBe(true);
  });

  it('forgets a window that is two or more windows old', async () => {
    const w = new SlidingWindow({ limit: 1, windowMs: 1000 });
    await w.hit('k', 0);
    expect((await w.hit('k', 2500)).allowed).toBe(true);
  });

  it('rejects a non-positive window', () => {
    expect(() => new SlidingWindow({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});
`;

const hero: Script = async t => {
  await t.reason('The user wants a sliding-window limiter next to the token bucket, behind the same Limiter interface. A pure sliding log is exact but stores every timestamp; a sliding-window counter (current + previous fixed window, weighted by overlap) is O(1) per key and is what most gateways use. Let me check the interface and how TokenBucket uses the store first.', 240);
  await t.tool('read_file', { path: 'src/limiter.ts' }, { ms: 380, result: { content: '…' } });
  await t.tool('read_file', { path: 'src/token-bucket.ts' }, { ms: 420, result: { content: '…' } });
  await t.tool('search_files', { pattern: 'implements Limiter', path: 'src' }, { ms: 300, context: 'implements Limiter', result: ok('src/token-bucket.ts:14:export class TokenBucket implements Limiter {') });
  await t.reason('Decision needs remaining, retryAfterMs and resetAt. The edge case that matters is a burst right before a boundary followed by one right after: with fixed windows that lets 2× the limit through. Weighting the previous window by its remaining overlap fixes it. I will also delegate a quick survey and a docs draft in parallel.', 260);
  await t.subagents([
    { goal: 'Survey how popular limiters weight the previous window at boundaries', tools: [['web_search', 'sliding window counter rate limit overlap'], ['web_extract', 'gateway docs: rate limiting algorithms'], ['read_file', 'src/token-bucket.ts']], summary: 'All weight the previous window by (1 − elapsed/window); none store per-hit timestamps.', ms: 2600 },
    { goal: 'Draft a README section for SlidingWindow with an example', tools: [['read_file', 'README.md'], ['write_file', 'notes/sliding-window.md']], summary: 'Drafted a short section with a 100 req/min example.', ms: 2200 },
  ]);
  await t.tool('write_file', { path: 'src/sliding-window.ts' }, { ms: 900, edit: { path: 'src/sliding-window.ts', content: SLIDING } });
  await t.tool('patch', { path: 'src/index.ts' }, { ms: 500, edit: { path: 'src/index.ts', replace: [["export { TokenBucket, type TokenBucketOptions } from './token-bucket.js';\n", "export { TokenBucket, type TokenBucketOptions } from './token-bucket.js';\nexport { SlidingWindow, type SlidingWindowOptions } from './sliding-window.js';\n"]] } });
  await t.tool('write_file', { path: 'test/sliding-window.test.ts' }, { ms: 800, edit: { path: 'test/sliding-window.test.ts', content: SLIDING_TEST } });
  await t.tool('patch', { path: 'README.md' }, { ms: 600, edit: { path: 'README.md', replace: [["## License", "### Sliding window\n\nSmoother than fixed windows, and a burst at the boundary can't double the limit:\n\n```ts\nimport { SlidingWindow } from 'tidepool';\n\nconst limiter = new SlidingWindow({ limit: 100, windowMs: 60_000 });\n```\n\n## License"]] } });
  await t.status('Running tests');
  await t.tool('terminal', { command: 'pnpm vitest run' }, { ms: 2200, hold: 'hero-tests', result: ok(` RUN  v2.1.4 tidepool\n\n ✓ test/token-bucket.test.ts (3 tests) 4ms\n ✓ test/middleware.test.ts (2 tests) 6ms\n ✓ test/sliding-window.test.ts (5 tests) 5ms\n ✓ test/redis-store.test.ts (2 tests) 71ms\n\n Test Files  4 passed (4)\n      Tests  12 passed (12)\n   Duration  412ms`) });
  await t.tool('terminal', { command: 'pnpm tsc --noEmit' }, { ms: 1300, result: ok('') });
  await t.say(`Added a sliding-window counter next to the token bucket, with tests.

- \`src/sliding-window.ts\`: \`SlidingWindow\` implements the same \`Limiter\` interface and works with any \`Store\`. It keeps two counters per key (current and previous window) and weights the previous one by how much of it still overlaps, so it's O(1) in memory per key.
- Bursts at a window boundary no longer double the limit: 4 hits at 990 ms plus 1 at 1010 ms is now denied.
- Exported from \`src/index.ts\`, with a short README section.
- \`test/sliding-window.test.ts\`: 5 tests (limit, boundary burst, sliding out, stale windows, bad options). All 12 tests pass and \`tsc\` is clean.

One choice to confirm: \`retryAfterMs\` is an estimate based on the previous window's rate. If you'd rather have it exact, I can switch to a sliding log for small limits.`, 300);
};

const MW_AFTER_FROM = `      if (!d.allowed) {
        res.statusCode = 429;`;
const MW_AFTER_TO = `      res.setHeader('RateLimit-Reset', String(Math.ceil((d.resetAt - Date.now()) / 1000)));
      if (!d.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(d.retryAfterMs / 1000)));
        res.statusCode = 429;`;
const MW_TEST_FROM = `    expect(res.statusCode).toBe(429);
  });`;
const MW_TEST_TO = `    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.headers['ratelimit-reset']).toBe('1');
  });`;

const retryAfter: Script = async t => {
  await t.reason('Rejected requests should tell clients when to come back. Decision already has retryAfterMs and resetAt, so this is just headers in the middleware: Retry-After in whole seconds on 429, and RateLimit-Reset on every response.', 230);
  await t.tool('read_file', { path: 'src/middleware.ts' }, { ms: 350 });
  await t.tool('patch', { path: 'src/middleware.ts' }, { ms: 650, edit: { path: 'src/middleware.ts', replace: [[MW_AFTER_FROM, MW_AFTER_TO]] } });
  await t.tool('patch', { path: 'test/middleware.test.ts' }, { ms: 550, edit: { path: 'test/middleware.test.ts', replace: [[MW_TEST_FROM, MW_TEST_TO]] } });
  await t.tool('terminal', { command: 'pnpm vitest run test/middleware.test.ts' }, { ms: 1300, result: ok(' ✓ test/middleware.test.ts (2 tests) 7ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)') });
  await t.say(`Done: rejected requests now tell clients when to retry.

- **\`Retry-After\`** on every 429, in whole seconds (rounded up).
- **\`RateLimit-Reset\`** on every response.

Both come straight from the limiter's decision.

The 429 test now asserts both headers; the middleware suite passes.`, 320);
};

// The hosted demo's one scripted turn (record.ts → worker): reasoning, tool calls with inline diffs, tests, then an
// approval before anything leaves the machine, and a streamed reply.
export const DEMO_PROMPT = 'Add Retry-After and RateLimit-Reset headers to rejected requests, run the tests, and push the branch.';
const demoTurn: Script = async t => {
  await t.reason('Rejected requests should tell clients when to come back. The limiter\'s Decision already carries retryAfterMs and resetAt, so this is two headers in the middleware plus a test. Pushing is the last step, and that needs your OK.', 230);
  await t.tool('read_file', { path: 'src/middleware.ts' }, { ms: 380, result: { content: '…' } });
  await t.tool('patch', { path: 'src/middleware.ts' }, { ms: 650, edit: { path: 'src/middleware.ts', replace: [[MW_AFTER_FROM, MW_AFTER_TO]] } });
  await t.tool('patch', { path: 'test/middleware.test.ts' }, { ms: 550, edit: { path: 'test/middleware.test.ts', replace: [[MW_TEST_FROM, MW_TEST_TO]] } });
  await t.status('Running tests');
  await t.tool('terminal', { command: 'pnpm vitest run' }, { ms: 1400, result: ok(' ✓ test/token-bucket.test.ts (3 tests) 4ms\n ✓ test/middleware.test.ts (2 tests) 7ms\n ✓ test/redis-store.test.ts (2 tests) 68ms\n\n Test Files  3 passed (3)\n      Tests  7 passed (7)') });
  await t.tool('terminal', { command: 'git push -u origin retry-after-headers' }, {
    ms: 1100, approval: { command: 'git push -u origin retry-after-headers', description: 'Pushes the new branch to the remote repository.' },
    result: ok('To github.com:tidepool/tidepool.git\n * [new branch]      retry-after-headers -> retry-after-headers\nbranch \'retry-after-headers\' set up to track \'origin/retry-after-headers\'.'),
  });
  await t.say(`Done: rejected requests now tell clients when to retry.

- **\`Retry-After\`** on every 429, in whole seconds (rounded up).
- **\`RateLimit-Reset\`** on every response.

Both come straight from the limiter's decision. The 429 test asserts both headers, all 7 tests pass, and the branch \`retry-after-headers\` is pushed.`, 320);
};

const flaky: Script = async t => {
  await t.reason('The Redis expiry test sleeps 60 ms for a 50 ms TTL. Redis checks PX expiry lazily plus a sampling sweep, but GET on an expired key always misses, so the sleep itself should be enough unless the clock between the test and the server drifts. Let me reproduce it under load first.', 230);
  await t.tool('read_file', { path: 'test/redis-store.test.ts' }, { ms: 300 });
  await t.tool('terminal', { command: 'pnpm vitest run test/redis-store.test.ts --repeat 20' }, { ms: 1800, result: { output: ' × test/redis-store.test.ts > RedisStore > expires entries (repeat 13)\n   AssertionError: expected 1 to be undefined\n\n Tests  1 failed | 39 passed (40)', exit_code: 1 } });
  await t.reason('1 in 20 under parallel load. The test container\'s clock and setTimeout are not the problem; the TTL is set after JSON.stringify and the network round trip, so 60 ms after the call can be <50 ms after Redis applied PX. Fix: poll for expiry with a deadline instead of a fixed sleep.', 230);
  await t.tool('patch', { path: 'test/redis-store.test.ts' }, { ms: 600, edit: { path: 'test/redis-store.test.ts', replace: [["    await new Promise(r => setTimeout(r, 60));\n    expect(await s.get('b')).toBeUndefined();", "    await expect.poll(() => s.get('b'), { timeout: 500, interval: 10 }).toBeUndefined();"]] } });
  await t.status('Running tests');
  await t.tool('terminal', { command: 'pnpm vitest run test/redis-store.test.ts --repeat 200' }, { ms: 4000, hold: 'flaky-forever', result: ok(' Tests  400 passed (400)') });
  await t.say('Fixed: the expiry test now polls instead of sleeping a fixed 60 ms. 400/400 passes under load.');
};

const tsUpgrade: Script = async t => {
  await t.reason('Upgrading TypeScript to 5.9 and @types/node to the Node 20 line. I need to add the packages, then check for new strictness errors (5.9 tightened a few lib types).', 230);
  await t.tool('read_file', { path: 'package.json' }, { ms: 300 });
  await t.tool('terminal', { command: 'pnpm outdated typescript @types/node' }, { ms: 900, result: ok('┌─────────────┬─────────┬────────┐\n│ Package     │ Current │ Latest │\n├─────────────┼─────────┼────────┤\n│ typescript  │ 5.6.3   │ 5.9.2  │\n│ @types/node │ 20.14.0 │ 20.19.1│\n└─────────────┴─────────┴────────┘') });
  await t.tool('terminal', { command: 'pnpm add -D typescript@5.9.2 @types/node@20.19.1' }, {
    ms: 1600, approval: { command: 'pnpm add -D typescript@5.9.2 @types/node@20.19.1', description: 'Installs packages from the npm registry and rewrites package.json and pnpm-lock.yaml.' },
    edit: { path: 'package.json', replace: [['"@types/node": "^20.14.0"', '"@types/node": "^20.19.1"'], ['"typescript": "^5.6.3"', '"typescript": "^5.9.2"']] },
    result: ok('Packages: +2 -2\nProgress: resolved 112, reused 110, downloaded 2, added 2, done\n\ndevDependencies:\n- typescript 5.6.3\n+ typescript 5.9.2\n- @types/node 20.14.0\n+ @types/node 20.19.1\n\nDone in 2.1s'),
  });
  await t.tool('terminal', { command: 'pnpm tsc --noEmit' }, { ms: 1400, result: ok('') });
  await t.tool('terminal', { command: 'pnpm vitest run' }, { ms: 1500, result: ok(' Test Files  3 passed (3)\n      Tests  7 passed (7)') });
  await t.say(`Upgraded TypeScript 5.6.3 → 5.9.2 and @types/node 20.14 → 20.19.

- \`tsc --noEmit\` is clean, no source changes needed.
- All tests pass.

\`package.json\` and the lockfile changed; nothing else.`, 300);
};

const pruneBranches: Script = async t => {
  await t.reason('Three release branches were merged long ago. I\'ll confirm they are fully merged into main before deleting them on the remote.', 230);
  await t.tool('terminal', { command: 'git branch -r --merged origin/main | grep release/' }, { ms: 700, result: ok('  origin/release/0.7\n  origin/release/0.8\n  origin/release/0.9-rc') });
  await t.tool('terminal', { command: 'git push origin --delete release/0.7 release/0.8 release/0.9-rc' }, {
    ms: 1200, approval: { command: 'git push origin --delete release/0.7 release/0.8 release/0.9-rc', description: 'Deletes three branches on the remote. They are fully merged into main.' },
    result: ok('To github.com:tidepool/tidepool.git\n - [deleted]         release/0.7\n - [deleted]         release/0.8\n - [deleted]         release/0.9-rc'),
  });
  await t.say('Deleted release/0.7, release/0.8 and release/0.9-rc on the remote. All three were already merged into main.', 300);
};

const readme: Script = async t => {
  await t.reason('The README only shows the token bucket. A quick-start should cover Express-style middleware and the Redis store, the two things people ask about.', 400);
  await t.tool('read_file', { path: 'README.md' }, { ms: 300 });
  await t.tool('read_file', { path: 'src/middleware.ts' }, { ms: 300 });
  await t.tool('patch', { path: 'README.md' }, { ms: 500, edit: { path: 'README.md', replace: [['## License', '## Quick start\n\n```ts\nimport express from \'express\';\nimport { rateLimit, TokenBucket } from \'tidepool\';\n\nconst app = express();\napp.use(rateLimit({ limiter: new TokenBucket({ capacity: 60, refillPerSecond: 1 }), limit: 60 }));\n```\n\n### Sharing limits across instances\n\n```ts\nimport { RedisStore } from \'tidepool/redis\';\n\nconst store = new RedisStore(redisClient);\nconst limiter = new TokenBucket({ capacity: 60, refillPerSecond: 1, store });\n```\n\n## License']] } });
  await t.say(`Added a Quick start section to the README:

1. Express middleware in four lines, with \`RateLimit-*\` headers explained.
2. Sharing one limit across instances with \`RedisStore\`.

\`\`\`ts
app.use(rateLimit({ limiter: new TokenBucket({ capacity: 60, refillPerSecond: 1 }), limit: 60 }));
\`\`\`

Both snippets type-check against the current exports.`, 400);
};

const bench: Script = async t => {
  await t.reason('Measure hits/s for the in-memory token bucket on this machine, then look at where time goes.', 400);
  await t.tool('terminal', { command: 'pnpm bench' }, { ms: 900, result: ok('1,000,000 hits in 612 ms (1,633,987 hits/s)') });
  await t.tool('terminal', { command: 'node --cpu-prof --import tsx bench/bucket.ts' }, { ms: 900, result: ok('1,000,000 hits in 655 ms (1,526,717 hits/s)\nWrote CPU.20261009.cpuprofile') });
  await t.say(`**~1.6M hits/s** for the in-memory bucket on Node 22 (single core).

| Where | Share |
| --- | --- |
| \`MemoryStore.get/set\` (Map + expiry check) | 54% |
| \`hit()\` arithmetic | 21% |
| Promise overhead | 25% |

The store dominates. A sync fast path for \`MemoryStore\` would roughly double throughput, but it changes the \`Store\` interface, so I left it as a suggestion.`, 400);
};

const cliJson: Script = async t => {
  await t.reason('`tidepool simulate` prints a sentence. A --json flag makes it scriptable; keep the default human output.', 400);
  await t.tool('read_file', { path: 'src/cli.ts' }, { ms: 300 });
  await t.tool('patch', { path: 'src/cli.ts' }, { ms: 500, edit: { path: 'src/cli.ts', replace: [["  console.log(`${ok} allowed, ${denied} denied over ${seconds}s at ${rps} rps`);", "  if (args.includes('--json')) console.log(JSON.stringify({ allowed: ok, denied, seconds, rps }));\n  else console.log(`${ok} allowed, ${denied} denied over ${seconds}s at ${rps} rps`);"]] } });
  await t.tool('terminal', { command: 'pnpm tsx src/cli.ts simulate --rps 8 --json' }, { ms: 600, result: ok('{"allowed":28,"denied":52,"seconds":10,"rps":8}') });
  await t.say('`tidepool simulate --json` now prints one JSON object (`allowed`, `denied`, `seconds`, `rps`). Without the flag the output is unchanged.', 400);
};

const docsDark: Script = async t => {
  await t.reason('Code blocks use a fixed dark background, which looks wrong in light mode and slightly off in dark mode. Use CSS variables keyed on prefers-color-scheme.', 400);
  await t.tool('read_file', { path: 'src/styles/code.css' }, { ms: 300 });
  await t.tool('write_file', { path: 'src/styles/code.css' }, { ms: 500, edit: { path: 'src/styles/code.css', content: ':root { --code-bg: #f4f5f8; --code-fg: #1d2129; }\n@media (prefers-color-scheme: dark) {\n  :root { --code-bg: #0f1117; --code-fg: #e6e8ee; }\n}\n\npre { background: var(--code-bg); color: var(--code-fg); border-radius: 8px; padding: 1rem; }\n' } });
  await t.say('Code blocks now follow the system theme through two CSS variables (`--code-bg`, `--code-fg`). Checked both themes in the dev server.', 400);
};

// ── board: workers and reviewers ─────────────────────────────────────────
const holds: Record<string, string> = { 'API reference': 'work-docs' };
const reviewHolds: Record<string, string> = { 'Lua script': 'review-lua' };

const worker: Script = async t => {
  const title = Object.keys(EDITS).find(k => t.prompt.includes(k)) ?? '';
  const fix = t.prompt.startsWith('A code reviewer looked at your changes');
  await t.reason(fix ? 'The reviewer asked for changes. Going through each point.' : `Starting on: ${title || 'the task'}. Reading the relevant code first.`, 300);
  if (!fix) {
    await t.tool('read_file', { path: 'src/index.ts' }, { ms: 300 });
    const hold = Object.entries(holds).find(([k]) => t.prompt.includes(k))?.[1];
    if (hold) await t.hold(hold);
    for (const e of EDITS[title] ?? []) await t.tool('patch', { path: e.path }, { ms: 500, edit: e });
  } else {
    const fixTitle = Object.keys(FIXES).find(k => t.s.title?.includes(k) || t.prompt.includes(k)) ?? '';
    for (const e of FIXES[fixTitle] ?? []) await t.tool('patch', { path: e.path }, { ms: 500, edit: e });
  }
  await t.tool('terminal', { command: 'pnpm vitest run' }, { ms: 800, result: ok(' Test Files  3 passed (3)\n      Tests  7 passed (7)') });
  return fix ? 'Addressed every review point; tests pass.' : `Done: ${title}. Tests pass.`;
};

const EDITS: Record<string, { path: string; content?: string; replace?: [string, string][] }[]> = {
  'Edge runtime build': [{ path: 'tsup.config.ts', content: "import { defineConfig } from 'tsup';\n\nexport default defineConfig({\n  entry: ['src/index.ts', 'src/stores/redis.ts'],\n  format: ['esm', 'cjs'],\n  dts: true,\n  platform: 'neutral',\n});\n" }],
  'Lua script': [{ path: 'src/stores/redis.ts', replace: [['export class RedisStore', '// Refill + take in one round trip, atomically (EVALSHA).\nexport const TAKE = `\nlocal b = redis.call("GET", KEYS[1])\nreturn b`;\n\nexport class RedisStore']] }],
  'API reference': [{ path: 'docs/api.md', content: '# API reference\n\n## TokenBucket\n\n`new TokenBucket({ capacity, refillPerSecond, store? })`\n\n## SlidingWindow\n\n`new SlidingWindow({ limit, windowMs, store? })`\n' }],
  'Publish workflow': [], 'Deno compatibility': [],
};

const FIXES: Record<string, { path: string; content?: string; replace?: [string, string][] }[]> = {
  'API reference': [{ path: 'docs/api.md', replace: [['## TokenBucket', '## Decision\n\n`allowed`, `remaining`, `retryAfterMs`, `resetAt` (epoch ms).\n\n## TokenBucket']] }],
  'Edge runtime build': [{ path: 'package.json', replace: [['"exports": { ".": "./dist/index.js", "./redis": "./dist/stores/redis.js" }', '"exports": {\n    ".": { "import": "./dist/index.js", "require": "./dist/index.cjs" },\n    "./redis": { "import": "./dist/stores/redis.js", "require": "./dist/stores/redis.cjs" }\n  }']] }],
};

const reviewer: Script = async t => {
  const again = t.prompt.startsWith('The author addressed');
  await t.reason('Reviewing the diff against main for correctness.', 300);
  await t.tool('terminal', { command: 'git status --short && git diff main --stat' }, { ms: 500, result: ok(' M src/index.ts\n?? docs/api.md\n docs/api.md | 9 +++++++++\n 1 file changed') });
  const hold = Object.entries(reviewHolds).find(([k]) => t.prompt.includes(k))?.[1];
  if (hold) await t.hold(hold);
  await t.tool('terminal', { command: 'pnpm vitest run' }, { ms: 700, result: ok(' Tests  7 passed (7)') });
  if (t.prompt.includes('API reference') && !again) return 'The reference covers both limiters, but it never documents what `hit()` returns.\n\nVERDICT: CHANGES\n1. Document the `Decision` type and each of its fields.';
  if (t.prompt.includes('Edge runtime build') && !again) return 'The build config is right, but `platform: neutral` needs the `exports` map to list the CJS entry.\n\nVERDICT: CHANGES\n1. Add a `require` condition for the CJS build to `exports`.';
  return 'Changes are small, correct and tested.\n\nVERDICT: APPROVE';
};

export function pick(prompt: string, _s: Session): Script {
  if (/strict code reviewer/.test(prompt)) return reviewer;
  if (/Commit nothing and do not push|A code reviewer looked at your changes/.test(prompt)) return worker;
  if (prompt === DEMO_PROMPT) return demoTurn;
  if (/sliding-window/i.test(prompt)) return hero;
  if (/Retry-After/.test(prompt)) return retryAfter;
  if (/flaky/i.test(prompt)) return flaky;
  if (/TypeScript 5\.9/.test(prompt)) return tsUpgrade;
  if (/release branches/.test(prompt)) return pruneBranches;
  if (/README/.test(prompt)) return readme;
  if (/[Bb]enchmark/.test(prompt)) return bench;
  if (/--json/.test(prompt)) return cliJson;
  if (/[Cc]ode blocks/.test(prompt)) return docsDark;
  return async t => { await t.reason('Looking into it.'); await t.say('Done.'); };
}

// Short sidebar titles (what Gibbous's own title pass would produce).
export function titleFor(input: string): string {
  const table: [RegExp, string][] = [
    [/sliding-window/i, 'Sliding-window limiter'], [/Retry-After/, 'Retry-After headers'], [/flaky/i, 'Fix flaky Redis test'],
    [/TypeScript 5\.9/, 'TypeScript 5.9 upgrade'], [/release branches/, 'Prune release branches'], [/README/, 'README quick start'],
    [/[Bb]enchmark/, 'Benchmark token bucket'], [/--json/, 'CLI --json output'], [/[Cc]ode blocks/, 'Theme-aware code blocks'],
  ];
  return table.find(([r]) => r.test(input))?.[1] ?? input.split(/\s+/).slice(0, 3).join(' ');
}
