// A stand-in `hermes` command for onboarding tests (e2e/setup-smoke.ts, the live setup check): `--version` prints a
// version, `serve --port N` runs the scripted fake backend (demo/fake-hermes.ts) on N with the token Gibbous passes in
// HERMES_DASHBOARD_SESSION_TOKEN. FAKE_HERMES_UNCONFIGURED=1 starts it without a usable model (the model step).
import { fakeHermes } from './demo/fake-hermes.ts';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Hermes Agent v0.11.2 (fake)'); process.exit(0); }
if (args[0] !== 'serve') { console.error(`fake hermes: unsupported command ${args.join(' ')}`); process.exit(2); }
const port = Number(args[args.indexOf('--port') + 1] || 9120);
const token = process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '';
const f = fakeHermes({ token, pick: () => async () => 'ok', home: process.env.HOME, setup: { configured: process.env.FAKE_HERMES_UNCONFIGURED !== '1' } });
f.speed.factor = 0;
await f.listen(port);
console.log(`fake hermes serve on :${port}`);
