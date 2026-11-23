'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInput, isAllowedUrl } = require('../../src/main/security/navigation');
const { isPermissionAllowed } = require('../../src/main/security/permissions');
const { isDangerousFile } = require('../../src/main/security/downloads');
const { isCertificateError } = require('../../src/main/security/certificates');
const { validators, createIpc } = require('../../src/main/security/ipc-validate');
const { baseWebPreferences, contentPreferences } = require('../../src/main/sandbox/web-preferences');
const { sanitizeSettings } = require('../../src/main/storage/settings');

test('only http and https URLs are allowed', () => {
  assert.equal(isAllowedUrl('https://example.com'), true);
  assert.equal(isAllowedUrl('http://example.com'), true);
  for (const url of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'not a url']) {
    assert.equal(isAllowedUrl(url), false, url);
  }
});

test('address bar input becomes a URL, a search, or is blocked', () => {
  assert.equal(resolveInput('example.com').url, 'https://example.com/');
  assert.equal(resolveInput('localhost:3000/app').url, 'https://localhost:3000/app');
  assert.equal(resolveInput('http://example.com/a?b=1').url, 'http://example.com/a?b=1');
  assert.equal(resolveInput('cute cats').searched, true);
  assert.equal(resolveInput('site:example.com cats').searched, true);
  assert.equal(resolveInput('cats').searched, true);
  for (const input of ['javascript:alert(1)', 'file:///C:/Windows', 'data:text/html,x', 'ftp://example.com']) {
    assert.deepEqual(resolveInput(input), { ok: false, reason: 'blocked-scheme' }, input);
  }
  assert.equal(resolveInput('   ').ok, false);
  assert.equal(resolveInput('a'.repeat(5000)).reason, 'too-long');
});

test('web content only receives the fullscreen and clipboard-write permissions', () => {
  assert.equal(isPermissionAllowed('fullscreen'), true);
  for (const permission of ['media', 'geolocation', 'notifications', 'display-capture', 'midi', 'clipboard-read']) {
    assert.equal(isPermissionAllowed(permission), false, permission);
  }
});

test('executable downloads are blocked, normal files are not', () => {
  for (const name of ['setup.exe', 'run.BAT', 'x.ps1', 'shortcut.lnk', 'lib.dll']) {
    assert.equal(isDangerousFile(name), true, name);
  }
  for (const name of ['photo.jpg', 'notes.pdf', 'video.mp4', 'archive']) {
    assert.equal(isDangerousFile(name), false, name);
  }
});

test('certificate failures are recognised', () => {
  assert.equal(isCertificateError(-202), true);
  assert.equal(isCertificateError(-501), true);
  assert.equal(isCertificateError(-105), false);
});

test('IPC rejects untrusted senders and malformed arguments', async () => {
  const handlers = new Map();
  const ipc = createIpc({ removeHandler: () => {}, handle: (channel, fn) => handlers.set(channel, fn) }, (event) => event.trusted);
  let calls = 0;
  ipc.handle('tabs:close', validators.tabId, () => { calls += 1; return 'ok'; });
  const invoke = handlers.get('tabs:close');

  assert.equal(invoke({ trusted: true }, 3), 'ok');
  assert.throws(() => invoke({ trusted: false }, 3), /untrusted sender/);
  assert.throws(() => invoke({ trusted: true }, '3'), /invalid arguments/);
  assert.throws(() => invoke({ trusted: true }, 3, 'extra'), /invalid arguments/);
  assert.equal(calls, 1);
});

test('recording chunks must be non-empty binary data within the size limit', () => {
  assert.equal(validators.chunk(new Uint8Array(10)), true);
  assert.equal(validators.chunk(new ArrayBuffer(10)), true);
  assert.equal(validators.chunk(new Uint8Array(0)), false);
  assert.equal(validators.chunk('text'), false);
});

test('sandbox settings are locked down and web content has no preload', () => {
  assert.equal(baseWebPreferences.sandbox, true);
  assert.equal(baseWebPreferences.contextIsolation, true);
  assert.equal(baseWebPreferences.nodeIntegration, false);
  assert.equal(baseWebPreferences.webSecurity, true);
  assert.equal(baseWebPreferences.webviewTag, false);
  assert.equal(contentPreferences('p').preload, undefined);
});

test('settings drop unsafe bookmarks and relative recording folders', () => {
  const settings = sanitizeSettings({
    bookmarks: [{ url: 'https://ok.example/', title: 'ok' }, { url: 'javascript:alert(1)', title: 'bad' }, null],
    recordingFolder: 'relative\\path',
  });
  assert.deepEqual(settings.bookmarks, [{ url: 'https://ok.example/', title: 'ok' }]);
  assert.equal(settings.recordingFolder, null);
});
