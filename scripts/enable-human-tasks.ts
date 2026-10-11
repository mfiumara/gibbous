// Explicit opt-in only. Never run this at boot, install, or in tests with the real Hermes home.
import { spawnSync } from 'node:child_process';
import { mcpSecret } from '../server/mcp.ts';
import { hermesBin, commandFor } from '../server/platform.ts';
const port = Number(process.env.GIBBOUS_PORT ?? 7878);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GIBBOUS_PORT');
const config = { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${mcpSecret.token}` } };
// Hermes parses JSON mappings itself; replaces the stale entry rather than duplicating it.
try {
  const c = commandFor(hermesBin(), ['config', 'set', 'mcp_servers.gibbous', JSON.stringify(config)]);
  const result = spawnSync(c.cmd, c.args, { stdio: 'pipe', windowsVerbatimArguments: c.verbatim });
  if (result.error || result.status !== 0) throw new Error('registration failed');
} catch { throw new Error('Could not register Gibbous with Hermes. Check hermes config set is available.'); }
console.log('Agent task filing enabled. Reload MCP in the agent (/reload-mcp), or start a new session.');
