// Paths come from the server's OS: `/` on macOS/Linux, `\\` on Windows. Split on both, never on '/' alone.
export const SEP = /[\\/]/;
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(SEP).pop() || p;
// The folder part of a relative path, separator kept ("src/app/" for "src/app/x.ts").
export const dirPrefix = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i + 1); };
// `p` under `home` shown as ~/…, on either separator.
export const tilde = (p: string, home: string) => p === home ? '~' : home && (p.startsWith(home + '/') || p.startsWith(home + '\\')) ? '~' + p.slice(home.length) : p;

export interface Service { platform: string; wsl: boolean; machine: string; restart: string }
// "this Mac" / "this PC" / "this computer" for copy about the machine the server runs on (older servers: Mac).
export const thisMachine = (s?: Pick<Service, 'machine'>) => `this ${s?.machine ?? 'Mac'}`;
