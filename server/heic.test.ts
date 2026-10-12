import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isHeic, heicToJpeg, cachedJpeg } from './heic.ts';

test('isHeic matches .heic/.heif in any case only', () => {
  assert.ok(isHeic('IMG_0001.HEIC') && isHeic('a.heif') && !isHeic('a.jpg') && !isHeic('heic.png'));
});

// sips can write HEIC on macOS, so the round trip is real there; elsewhere this checks the failure path.
test('heicToJpeg converts a real HEIC (macOS) or fails cleanly', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-test-'));
  try {
    if (process.platform !== 'darwin') { await assert.rejects(heicToJpeg(Buffer.from('not an image'))); return; }
    const png = path.join(dir, 'a.png'), heic = path.join(dir, 'a.heic');
    execFileSync('sips', ['-s', 'format', 'png', '-z', '8', '8', '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns', '--out', png], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' });
    const jpg = await heicToJpeg(fs.readFileSync(heic));
    assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const cache = path.join(dir, 'cache'), a = await cachedJpeg(heic, cache), b = await cachedJpeg(heic, cache);
    assert.equal(a, b); assert.equal(fs.readdirSync(cache).length, 1);
    await assert.rejects(heicToJpeg(Buffer.from('not an image')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
