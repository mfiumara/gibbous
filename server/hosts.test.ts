// The remote start script is the security-sensitive part: the token lives only in a private file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScript } from './hosts.ts';

test('remote start script writes the token into a private desktop-ssh file, never argv/env', () => {
  const s = startScript('deadbeef'.repeat(6), 9151);
  assert.match(s, /chmod 700 "\$root" "\$d"; umask 077/);
  assert.match(s, /printf %s 'deadbeef/);
  assert.match(s, /HERMES_DESKTOP=1 nohup .* serve --port 9151 .*--ssh-session-token-file "\$d\/[0-9a-f]{16}\.token"/);
  assert.doesNotMatch(s, /HERMES_DASHBOARD_SESSION_TOKEN/);
  assert.match(s, /root="\$HOME\/\.hermes\/desktop-ssh"; d="\$root\/[0-9a-f]{32}"/); // the path Hermes validates
});
