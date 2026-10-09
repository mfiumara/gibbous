import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './diagnostics.ts';

test('debug bundle redaction scrubs known and token-shaped secrets, keeps the rest', () => {
  const out = redact('login ?token=abc123secretvalue ok\nAuthorization: Bearer xyz.987\n{"api_key": "hunter22"} sk-ant-api03-AAAAAAAAAAAAAAAAAA ' +
    'sess 0123456789abcdef0123456789abcdef mine:MYSECRETVALUE port 9120', ['MYSECRETVALUE']);
  for (const s of ['abc123secretvalue', 'xyz.987', 'hunter22', 'sk-ant', '0123456789abcdef', 'MYSECRETVALUE']) assert.ok(!out.includes(s), s);
  assert.ok(out.includes('port 9120') && out.includes('Authorization: Bearer [redacted]'));
});
