// First-run setup, pure parts (tested in onboarding.test.ts): which step to show, when to show it at all, the provider
// choices, and the install log buffer. The screen is Setup.tsx; the server side is server/setup.ts.

// /api/state `hermes` and the `setup` event (server/main.ts setupPublic()).
export interface HermesSetup {
  ready?: boolean; installed?: boolean; bin?: string; version?: string; error?: string;
  configured?: boolean | null; provider?: string; model?: string; freeTier?: boolean; reason?: string;
  updateAvailable?: boolean; gatewayRunning?: boolean;
}
export type SetupStep = 'install' | 'starting' | 'model' | 'done';

// install → (Hermes starting) → model → done. `ready` is the store's live hermesReady.
export function setupStep(h: HermesSetup | undefined, ready: boolean): SetupStep {
  if (!h) return 'starting';
  if (!ready && h.installed === false) return 'install';
  if (!ready) return 'starting';
  return h.configured === false ? 'model' : 'done';
}

// Open setup on its own only when something definitely needs doing: Hermes missing, or Hermes running without a
// usable model. Unknowns (older Hermes, a check still running, Hermes restarting) never trap anyone in setup.
export const needsSetup = (h: HermesSetup | undefined, ready: boolean) =>
  !!h && ((!ready && h.installed === false) || (ready && h.configured === false));

export const MAX_LOG = 500;
// `replace`: the last line was a progress redraw (a \r line on the server) and this one takes its place.
export const appendLog = (lines: string[], line: string, replace = false, max = MAX_LOG) =>
  replace && lines.length ? [...lines.slice(0, -1), line] : lines.length >= max ? [...lines.slice(lines.length - max + 1), line] : [...lines, line];

// Ways to give the agent a model. `oauth` = Hermes' in-app device-code sign-in (REST on `hermes serve`); `key` =
// paste an API key (Hermes' PUT /api/env); `terminal` = something Hermes only does in a terminal (Claude's
// subscription login is deliberately terminal-only upstream).
export type Choice =
  | { kind: 'oauth'; id: string; label: string; blurb: string }
  | { kind: 'key'; id: string; label: string; blurb: string; envKey: string; placeholder?: string; url?: string }
  | { kind: 'terminal'; id: string; label: string; blurb: string; command: string };

export const SIGN_INS: Choice[] = [
  { kind: 'oauth', id: 'openai-codex', label: 'ChatGPT', blurb: 'Sign in with your ChatGPT Plus or Pro plan' },
  { kind: 'terminal', id: 'anthropic', label: 'Claude', blurb: 'Use your Claude Pro or Max plan', command: 'hermes auth add anthropic' },
  { kind: 'oauth', id: 'nous', label: 'Nous Portal', blurb: 'Nous Research’s models, free tier included' },
];
export const KEYS: Choice[] = [
  { kind: 'key', id: 'anthropic', label: 'Anthropic', blurb: 'Claude models, billed to your API account', envKey: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-…', url: 'https://console.anthropic.com/settings/keys' },
  { kind: 'key', id: 'openai-api', label: 'OpenAI', blurb: 'GPT models, billed to your API account', envKey: 'OPENAI_API_KEY', placeholder: 'sk-…', url: 'https://platform.openai.com/api-keys' },
  { kind: 'key', id: 'openrouter', label: 'OpenRouter', blurb: 'One key for hundreds of models', envKey: 'OPENROUTER_API_KEY', placeholder: 'sk-or-…', url: 'https://openrouter.ai/keys' },
  { kind: 'key', id: 'gemini', label: 'Google AI Studio', blurb: 'Gemini models', envKey: 'GOOGLE_API_KEY', url: 'https://aistudio.google.com/apikey' },
];
export const ELSEWHERE: Choice = { kind: 'terminal', id: 'other', label: 'Something else', blurb: 'Local models, AWS Bedrock, Vertex AI, a custom endpoint…', command: 'hermes model' };

// Every other API-key provider Hermes knows (GET /api/model/options?include_unconfigured=1), A–Z, for "More providers".
export interface OptionProvider { slug: string; name: string; auth_type?: string; key_env?: string; authenticated?: boolean; models?: string[] }
export function moreKeyProviders(providers: OptionProvider[]): Choice[] {
  const shown = new Set(KEYS.map(k => k.id)), seen = new Set<string>();
  return providers
    .filter(p => p.auth_type === 'api_key' && p.key_env && !shown.has(p.slug) && !seen.has(p.slug) && (seen.add(p.slug), true))
    .map(p => ({ kind: 'key' as const, id: p.slug, label: p.name, blurb: p.key_env!, envKey: p.key_env! }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
}

// The model to start on: the backend's recommendation when it's on offer, else what's current, else the first.
export function pickModel(models: string[], recommended?: string, current?: string) {
  if (recommended && (models.includes(recommended) || !models.length)) return recommended;
  if (current && models.includes(current)) return current;
  return models[0] ?? recommended ?? '';
}

export const osLabel = (os?: string) => os === 'macos' ? 'Mac' : os === 'windows' ? 'PC' : 'computer';
