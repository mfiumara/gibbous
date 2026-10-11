// `pnpm test` on every OS: unit tests with a throwaway GIBBOUS_HOME (an env prefix like `X=1 node …` is POSIX-only).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const home = path.join(os.tmpdir(), 'gibbous-test-home');
const globs = process.argv.length > 2 ? process.argv.slice(2) : ['server/*.test.ts', 'web/src/**/*.test.ts'];
const r = spawnSync(process.execPath, ['--test', ...globs], { stdio: 'inherit', env: { ...process.env, GIBBOUS_HOME: home } });
process.exit(r.status ?? 1);
