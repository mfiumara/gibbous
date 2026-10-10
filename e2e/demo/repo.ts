// The demo project: "tidepool", a small fictional open-source rate limiter for Node and edge runtimes, with a few
// weeks of git history, plus a tiny docs site. Everything is generated, no real people or companies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const AUTHOR = { name: 'Tidepool Maintainers', email: 'maintainers@tidepool.example' };

const F: Record<string, string> = {};

F['package.json'] = `{
  "name": "tidepool",
  "version": "0.9.0",
  "description": "A tiny, dependency-free rate limiter for Node and edge runtimes.",
  "license": "MIT",
  "type": "module",
  "exports": { ".": "./dist/index.js", "./redis": "./dist/stores/redis.js" },
  "bin": { "tidepool": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run",
    "bench": "node --import tsx bench/bucket.ts",
    "lint": "biome check src test"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  },
  "engines": { "node": ">=18" }
}
`;

F['tsconfig.json'] = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`;

F['README.md'] = `# tidepool

A tiny, dependency-free rate limiter for Node and edge runtimes.

- Token bucket with burst and steady refill
- Pluggable stores: in-memory (default) and Redis
- \`RateLimit-*\` headers for any \`(req, res, next)\` server
- A CLI to inspect and benchmark limits

## Install

\`\`\`sh
npm install tidepool
\`\`\`

## Usage

\`\`\`ts
import { TokenBucket, MemoryStore } from 'tidepool';

const limiter = new TokenBucket({ capacity: 20, refillPerSecond: 5, store: new MemoryStore() });
const { allowed, retryAfterMs } = await limiter.hit(\`ip:\${req.ip}\`);
\`\`\`

## License

MIT
`;

F['LICENSE'] = `MIT License

Copyright (c) 2026 Tidepool contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

F['.gitignore'] = `node_modules
dist
coverage
`;

F['src/limiter.ts'] = `// The contract every limiter implements, and the storage it runs on.

export interface Decision {
  allowed: boolean;
  /** Hits left in the current window or bucket. */
  remaining: number;
  /** How long to wait before the next hit can succeed (0 when allowed). */
  retryAfterMs: number;
  /** Epoch ms when the limit fully resets. */
  resetAt: number;
}

export interface Limiter {
  /** Take one hit for \`key\`. */
  hit(key: string, now?: number): Promise<Decision>;
  /** Forget everything about \`key\`. */
  reset(key: string): Promise<void>;
}

export interface Store<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}
`;

F['src/token-bucket.ts'] = `import type { Decision, Limiter, Store } from './limiter.js';
import { MemoryStore } from './stores/memory.js';

export interface TokenBucketOptions {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens added back per second. */
  refillPerSecond: number;
  store?: Store<Bucket>;
}

interface Bucket { tokens: number; updatedAt: number }

export class TokenBucket implements Limiter {
  private readonly store: Store<Bucket>;

  constructor(private readonly opts: TokenBucketOptions) {
    if (opts.capacity <= 0) throw new RangeError('capacity must be positive');
    if (opts.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be positive');
    this.store = opts.store ?? new MemoryStore<Bucket>();
  }

  async hit(key: string, now = Date.now()): Promise<Decision> {
    const { capacity, refillPerSecond } = this.opts;
    const prev = (await this.store.get(key)) ?? { tokens: capacity, updatedAt: now };
    const elapsed = Math.max(0, now - prev.updatedAt) / 1000;
    const tokens = Math.min(capacity, prev.tokens + elapsed * refillPerSecond);
    const allowed = tokens >= 1;
    const next = { tokens: allowed ? tokens - 1 : tokens, updatedAt: now };
    const ttl = Math.ceil((capacity / refillPerSecond) * 1000);
    await this.store.set(key, next, ttl);
    const missing = allowed ? 0 : 1 - tokens;
    return {
      allowed,
      remaining: Math.floor(next.tokens),
      retryAfterMs: Math.ceil((missing / refillPerSecond) * 1000),
      resetAt: now + Math.ceil(((capacity - next.tokens) / refillPerSecond) * 1000),
    };
  }

  reset(key: string) {
    return this.store.delete(key);
  }
}
`;

F['src/stores/memory.ts'] = `import type { Store } from '../limiter.js';

/** A process-local store. Entries expire lazily on read. */
export class MemoryStore<T> implements Store<T> {
  private readonly map = new Map<string, { value: T; expires: number }>();

  async get(key: string) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) { this.map.delete(key); return undefined; }
    return e.value;
  }

  async set(key: string, value: T, ttlMs: number) {
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }

  async delete(key: string) {
    this.map.delete(key);
  }
}
`;

F['src/stores/redis.ts'] = `import type { Store } from '../limiter.js';

/** The subset of a Redis client we need (works with ioredis and node-redis v4). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisStore<T> implements Store<T> {
  constructor(private readonly redis: RedisLike, private readonly prefix = 'tidepool:') {}

  async get(key: string) {
    const raw = await this.redis.get(this.prefix + key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: T, ttlMs: number) {
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'PX', ttlMs);
  }

  async delete(key: string) {
    await this.redis.del(this.prefix + key);
  }
}
`;

F['src/middleware.ts'] = `import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Limiter } from './limiter.js';

export interface MiddlewareOptions {
  limiter: Limiter;
  /** Which bucket a request counts against. Defaults to the client IP. */
  key?: (req: IncomingMessage) => string;
  limit: number;
}

export function rateLimit({ limiter, key = req => req.socket.remoteAddress ?? 'unknown', limit }: MiddlewareOptions) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    try {
      const d = await limiter.hit(key(req));
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(d.remaining));
      if (!d.allowed) {
        res.statusCode = 429;
        res.end('Too Many Requests');
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
`;

F['src/cli.ts'] = `#!/usr/bin/env node
import { TokenBucket } from './token-bucket.js';

const [cmd = 'help', ...args] = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(\`--\${name}\`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

if (cmd === 'simulate') {
  const limiter = new TokenBucket({ capacity: flag('capacity', 10), refillPerSecond: flag('rate', 2) });
  const rps = flag('rps', 5), seconds = flag('seconds', 10);
  let ok = 0, denied = 0;
  for (let t = 0; t < seconds * 1000; t += 1000 / rps) {
    const d = await limiter.hit('sim', t);
    d.allowed ? ok++ : denied++;
  }
  console.log(\`\${ok} allowed, \${denied} denied over \${seconds}s at \${rps} rps\`);
} else {
  console.log('usage: tidepool simulate [--capacity n] [--rate n] [--rps n] [--seconds n]');
}
`;

F['src/index.ts'] = `export type { Decision, Limiter, Store } from './limiter.js';
export { TokenBucket, type TokenBucketOptions } from './token-bucket.js';
export { MemoryStore } from './stores/memory.js';
export { rateLimit, type MiddlewareOptions } from './middleware.js';
`;

F['test/token-bucket.test.ts'] = `import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/token-bucket.js';

describe('TokenBucket', () => {
  it('allows a full burst, then denies', async () => {
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    for (let i = 0; i < 3; i++) expect((await b.hit('k', 0)).allowed).toBe(true);
    const d = await b.hit('k', 0);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1000);
  });

  it('refills over time', async () => {
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 2 });
    await b.hit('k', 0); await b.hit('k', 0);
    expect((await b.hit('k', 500)).allowed).toBe(true);
  });

  it('keeps keys independent', async () => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await b.hit('a', 0);
    expect((await b.hit('b', 0)).allowed).toBe(true);
  });
});
`;

F['test/middleware.test.ts'] = `import { describe, expect, it } from 'vitest';
import { rateLimit } from '../src/middleware.js';
import { TokenBucket } from '../src/token-bucket.js';
import { fakeReq, fakeRes } from './helpers.js';

describe('rateLimit middleware', () => {
  it('sets RateLimit headers and calls next', async () => {
    const mw = rateLimit({ limiter: new TokenBucket({ capacity: 2, refillPerSecond: 1 }), limit: 2 });
    const res = fakeRes();
    let called = false;
    await mw(fakeReq(), res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.headers['ratelimit-remaining']).toBe('1');
  });

  it('answers 429 once the bucket is empty', async () => {
    const mw = rateLimit({ limiter: new TokenBucket({ capacity: 1, refillPerSecond: 1 }), limit: 1 });
    await mw(fakeReq(), fakeRes(), () => {});
    const res = fakeRes();
    await mw(fakeReq(), res, () => {});
    expect(res.statusCode).toBe(429);
  });
});
`;

F['test/helpers.ts'] = `import type { IncomingMessage, ServerResponse } from 'node:http';

export const fakeReq = (ip = '203.0.113.7') => ({ socket: { remoteAddress: ip }, headers: {} }) as unknown as IncomingMessage;

export function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200, headers, body: '',
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    end(b = '') { res.body = b; },
  };
  return res as unknown as ServerResponse & { headers: Record<string, string>; body: string };
}
`;

F['test/redis-store.test.ts'] = `import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisStore } from '../src/stores/redis.js';
import { startRedis, type TestRedis } from './redis-server.js';

let redis: TestRedis;
beforeAll(async () => { redis = await startRedis(); });
afterAll(() => redis.stop());

describe('RedisStore', () => {
  it('round-trips values', async () => {
    const s = new RedisStore<{ n: number }>(redis.client);
    await s.set('a', { n: 1 }, 1000);
    expect(await s.get('a')).toEqual({ n: 1 });
  });

  it('expires entries', async () => {
    const s = new RedisStore<number>(redis.client);
    await s.set('b', 1, 50);
    await new Promise(r => setTimeout(r, 60));
    expect(await s.get('b')).toBeUndefined();
  });
});
`;

F['bench/bucket.ts'] = `import { TokenBucket } from '../src/token-bucket.js';

const b = new TokenBucket({ capacity: 100, refillPerSecond: 50 });
const n = 1_000_000, t0 = performance.now();
for (let i = 0; i < n; i++) await b.hit(\`k\${i % 1000}\`, i);
const ms = performance.now() - t0;
console.log(\`\${n.toLocaleString()} hits in \${ms.toFixed(0)} ms (\${Math.round(n / ms * 1000).toLocaleString()} hits/s)\`);
`;

F['.github/workflows/ci.yml'] = `name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [18, 20, 22] }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "\${{ matrix.node }}", cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
`;

F['CHANGELOG.md'] = `# Changelog

## 0.9.0
- RedisStore for multi-instance deployments
- \`tidepool simulate\` CLI

## 0.8.0
- RateLimit-* headers in the middleware
`;

// Commit history: [message, files touched (all files exist by the end), days ago].
const HISTORY: [string, string[], number][] = [
  ['Initial commit: token bucket limiter', ['package.json', 'tsconfig.json', 'LICENSE', '.gitignore', 'src/limiter.ts', 'src/token-bucket.ts', 'src/stores/memory.ts', 'src/index.ts'], 34],
  ['Add vitest and token bucket tests', ['test/token-bucket.test.ts'], 33],
  ['README: install and usage', ['README.md'], 30],
  ['HTTP middleware with RateLimit-* headers', ['src/middleware.ts', 'test/middleware.test.ts', 'test/helpers.ts'], 24],
  ['CI on Node 18, 20 and 22', ['.github/workflows/ci.yml'], 21],
  ['RedisStore for multi-instance deployments', ['src/stores/redis.ts', 'test/redis-store.test.ts'], 14],
  ['tidepool simulate: a CLI to try limits', ['src/cli.ts'], 9],
  ['Benchmark script', ['bench/bucket.ts'], 6],
  ['Release 0.9.0', ['CHANGELOG.md'], 3],
];

const DOCS: Record<string, string> = {
  'package.json': `{\n  "name": "tidepool-docs",\n  "private": true,\n  "type": "module",\n  "scripts": { "dev": "astro dev", "build": "astro build" },\n  "dependencies": { "astro": "^4.16.0" }\n}\n`,
  'src/pages/index.md': `---\ntitle: tidepool\n---\n\n# tidepool\n\nRate limiting that fits in your head.\n`,
  'src/pages/guides/redis.md': `---\ntitle: Redis store\n---\n\nUse \`RedisStore\` when several instances share one limit.\n`,
  'src/styles/code.css': `pre { background: #0f1117; border-radius: 8px; padding: 1rem; }\n`,
};

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function write(dir: string, files: Record<string, string>, only?: string[]) {
  for (const f of only ?? Object.keys(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), files[f]);
  }
}

function commit(dir: string, msg: string, daysAgo: number) {
  const d = new Date(Date.now() - daysAgo * 86400_000 - 3600_000 * ((msg.length * 7) % 9)).toISOString();
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], {
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
    GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d,
  });
}

export function createRepos(codeDir: string) {
  const tide = path.join(codeDir, 'tidepool'), docs = path.join(codeDir, 'tidepool-docs');
  for (const [dir, files, history] of [[tide, F, HISTORY], [docs, DOCS, [['Docs site skeleton', ['package.json', 'src/pages/index.md', 'src/styles/code.css'], 12], ['Redis guide', ['src/pages/guides/redis.md'], 5]]]] as const) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    for (const [msg, files_, days] of history as [string, string[], number][]) { write(dir, files as Record<string, string>, files_); commit(dir, msg, days); }
  }
  return { tide, docs };
}
