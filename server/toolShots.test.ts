import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolShots, imagePaths } from './toolShots.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-shots-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('imagePaths finds absolute image paths in nested results, escaped JSON included', () => {
  const r = ['<x>{"output": "/a/b/shot.png\\n", "screenshot_path": "/a/b/shot.png"}', { nested: ['see /c/plot.webp here'] }, 'relative.png no'];
  assert.deepEqual(imagePaths(r).sort(), ['/a/b/shot.png', '/c/plot.webp']);
});

test('each finished step keeps its own copy, even when the tool overwrites one file', () => {
  const shot = path.join(dir, 'shot.png'), shots = new ToolShots(path.join(dir, 'kept'));
  fs.writeFileSync(shot, 'first');
  shots.keep('call-1', { output: shot });
  fs.writeFileSync(shot, 'second');
  shots.keep('call-2', `screenshot at ${shot}`);
  assert.equal(fs.readFileSync(shots.find('call-1', shot)!, 'utf8'), 'first');
  assert.equal(fs.readFileSync(shots.find('call-2', shot)!, 'utf8'), 'second');
  assert.equal(shots.find('call-3', shot), undefined);
});
