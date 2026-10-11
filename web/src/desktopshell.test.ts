import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopPlatform, desktopNotification } from './desktopshell.ts';

test('only the Tauri shell platforms count as the desktop app', () => {
  assert.equal(desktopPlatform('windows'), 'windows');
  assert.equal(desktopPlatform('linux'), 'linux');
  assert.equal(desktopPlatform('ios'), null);       // iPhone app
  assert.equal(desktopPlatform(undefined), null);   // browsers and Gibbous.app (no platform)
  assert.equal(desktopPlatform('mac'), null);
});

test('notifications skip the thread on screen and fill defaults otherwise', () => {
  assert.equal(desktopNotification({ title: 'Done', url: '/#/t/a' }, true), null);
  assert.deepEqual(desktopNotification({ title: 'Done', body: 'ok', url: '/#/t/a', tag: 't:a' }, false), { title: 'Done', body: 'ok', url: '/#/t/a', tag: 't:a' });
  assert.deepEqual(desktopNotification({}, false), { title: 'Gibbous', body: '', url: '', tag: '' });
});
