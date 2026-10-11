// Compatibility check after a Hermes update: every JSON-RPC method Gibbous calls must exist in the installed
// Hermes's own contract, and a few read-only calls must answer. Method names are scanned from our source, so
// the list never drifts.
import fs from 'node:fs';
import path from 'node:path';
import type { HermesClient, Backend } from './hermes.ts';
import { restGet } from './hermes.ts';
import { hermesHome } from './platform.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
export const INSTALLED_CONTRACT = path.join(hermesHome(), 'hermes-agent', 'apps', 'shared', 'src', 'gateway-contract.generated.ts');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'hermes' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !e.name.includes('.test.') && e.name !== 'fake-hermes.ts' ? [p] : [];
  });
}

export function usedMethods() {
  // The desktop apps' bundled server ships without web/src: scripts/bundle-server.mjs writes the list next to us.
  const shipped = path.join(import.meta.dirname, 'used-methods.json');
  if (!fs.existsSync(path.join(ROOT, 'web', 'src')) && fs.existsSync(shipped)) return JSON.parse(fs.readFileSync(shipped, 'utf8')) as string[];
  const s = new Set<string>();
  for (const f of [...sources(path.join(ROOT, 'server')), ...sources(path.join(ROOT, 'web/src'))])
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bcall(?:<[^>]*>)?\('([a-z_]+(?:\.[a-z_]+)+)'/g)) s.add(m[1]);
  return [...s].sort();
}

export const contractMethods = (file: string) => new Set([...fs.readFileSync(file, 'utf8').matchAll(/^\s*'([a-z_.]+)': \{ params/gm)].map(m => m[1]));

export async function smoke(hc: HermesClient, b: Backend) {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = async (name: string, f: () => Promise<unknown>) => {
    try { await f(); checks.push({ name, ok: true }); } catch (e: any) { checks.push({ name, ok: false, detail: String(e?.message ?? e) }); }
  };
  await check('Hermes contract has every method Gibbous uses', async () => {
    const have = contractMethods(INSTALLED_CONTRACT);
    const missing = usedMethods().filter(m => !have.has(m));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });
  for (const m of ['session.list', 'profiles.list', 'model.options', 'mcp.servers.list'])
    await check(m, () => hc.call(m, {}, 15_000));
  for (const p of ['/api/config', '/api/analytics/usage?days=1', '/api/hermes/update/check'])
    await check(`GET ${p.split('?')[0]}`, () => restGet(b, p));
  return { ok: checks.every(c => c.ok), checks };
}
