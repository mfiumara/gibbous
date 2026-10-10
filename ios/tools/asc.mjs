// App Store Connect API helper: node ios/tools/asc.mjs GET /v1/apps?filter[bundleId]=dev.gibbous.ios
// Key: ~/.appstoreconnect/gibbous.json {keyId, issuerId} + ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8
import crypto from 'node:crypto'; import fs from 'node:fs';
const dir = process.env.HOME + '/.appstoreconnect';
const { keyId, issuerId } = JSON.parse(fs.readFileSync(dir + '/gibbous.json', 'utf8'));
const key = fs.readFileSync(`${dir}/private_keys/AuthKey_${keyId}.p8`, 'utf8');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' }) + '.' + b64({ iss: issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
const jwt = head + '.' + crypto.sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
export async function asc(method, path, body) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + path, { method, headers: { authorization: 'Bearer ' + jwt, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [m, p, b] = process.argv.slice(2); const r = await asc(m, p, b && JSON.parse(b));
  console.log(r.status, JSON.stringify(r.json, null, 1));
}
