'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInput, isAllowedUrl } = require('../../src/main/security/navigation');
const { isPermissionAllowed } = require('../../src/main/security/permissions');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { isDangerousFile, guardDownload } = require('../../src/main/security/downloads');
const { DownloadManager } = require('../../src/main/download-manager');
const { isCertificateError } = require('../../src/main/security/certificates');
const { validators, createIpc } = require('../../src/main/security/ipc-validate');
const { registerIpcHandlers } = require('../../src/main/ipc-handlers');
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
  for (const name of ['photo.jpg', 'notes.pdf', 'video.mp4', 'archive', 'data.zip', 'image.png', '...']) {
    assert.equal(isDangerousFile(name), false, name);
  }
});

test('risky container, shortcut and installer types are blocked too', () => {
  for (const name of ['disk.iso', 'disk.IMG', 'drive.vhdx', 'help.chm', 'site.url', 'x.scf', 'patch.msp',
    'app.application', 'app.appref-ms', 'addin.xll', 'pack.cab', 'pkg.appinstaller']) {
    assert.equal(isDangerousFile(name), true, name);
  }
});

test('trailing dots and spaces and full Windows paths do not hide the extension', () => {
  for (const name of ['setup.exe.', 'setup.exe ', 'setup.exe. .', 'C:\\Users\\me\\Downloads\\setup.exe', 'C:\\dl\\notes.txt\\..\\run.bat']) {
    assert.equal(isDangerousFile(name), true, name);
  }
  assert.equal(isDangerousFile('C:\\dl.exe\\notes.txt'), false);
});

function fakeDownload(filename) {
  const item = new EventEmitter();
  let savePath = '';
  Object.assign(item, {
    cancelled: false,
    dialogOptions: null,
    getFilename: () => filename,
    getSavePath: () => savePath,
    setSavePath: (value) => { savePath = value; },
    setSaveDialogOptions: (options) => { item.dialogOptions = options; },
    cancel: () => { item.cancelled = true; item.emit('done', {}, 'cancelled'); },
    choose: (value) => { savePath = value; },
  });
  return item;
}

function guard(item, extra = {}) {
  const log = { blocked: [], started: 0, removed: [] };
  const accepted = guardDownload(item, {
    onBlocked: (name) => log.blocked.push(name),
    onStart: () => { log.started += 1; },
    defaultDir: 'C:\\Users\\me\\Downloads',
    remove: (file) => log.removed.push(file),
    ...extra,
  });
  return { accepted, log };
}

test('a blocked name from the website is refused before the Save dialog', () => {
  const item = fakeDownload('setup.exe');
  const { accepted, log } = guard(item);
  assert.equal(accepted, false);
  assert.equal(item.cancelled, true);
  assert.equal(item.dialogOptions, null);
  assert.deepEqual(log, { blocked: ['setup.exe'], started: 0, removed: [] });
});

test('a safe name gets a Save dialog in the Downloads folder', () => {
  const item = fakeDownload('report.txt');
  const { accepted, log } = guard(item);
  assert.equal(accepted, true);
  assert.equal(item.dialogOptions.defaultPath, path.join('C:\\Users\\me\\Downloads', 'report.txt'));
  item.choose('C:\\Users\\me\\Downloads\\report.txt');
  item.emit('updated', {}, 'progressing');
  item.emit('done', {}, 'completed');
  assert.equal(item.cancelled, false);
  assert.deepEqual(log, { blocked: [], started: 1, removed: [] });
});

test('renaming to a blocked type in the Save dialog cancels the download', async () => {
  const item = fakeDownload('report.txt');
  const blockedEvents = [];
  item.on('blocked', () => blockedEvents.push('blocked'));
  const { log } = guard(item);
  item.emit('updated', {}, 'progressing'); // still in the dialog: no path yet
  assert.equal(item.cancelled, false);
  item.choose('C:\\Users\\me\\Downloads\\report.exe');
  item.emit('updated', {}, 'progressing');
  item.emit('updated', {}, 'progressing');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(item.cancelled, true);
  assert.deepEqual(blockedEvents, ['blocked']);
  assert.deepEqual(log.blocked, ['report.exe']);
  assert.deepEqual(log.removed, []);
});

test('a renamed download that finishes before any update is deleted', () => {
  const item = fakeDownload('report.txt');
  const blockedEvents = [];
  item.on('blocked', () => blockedEvents.push('blocked'));
  const { log } = guard(item);
  item.choose('C:\\Users\\me\\Downloads\\report.bat.');
  item.emit('done', {}, 'completed');
  assert.deepEqual(blockedEvents, ['blocked']);
  assert.deepEqual(log.blocked, ['report.bat.']);
  assert.deepEqual(log.removed, ['C:\\Users\\me\\Downloads\\report.bat.']);
});

test('the download list marks a blocked download and does not report it as complete', () => {
  const manager = new DownloadManager();
  const completed = [];
  manager.on('completed', (entry) => completed.push(entry.filename));
  const item = fakeDownload('report.txt');
  Object.assign(item, { getTotalBytes: () => 10, getReceivedBytes: () => 10, isPaused: () => false });
  guard(item, { onStart: (download) => manager.track(download) });
  item.choose('C:\\dl\\report.exe');
  item.emit('done', {}, 'completed');
  assert.equal(manager.list()[0].state, 'blocked');
  assert.deepEqual(completed, []);
});

test('certificate failures are recognised', () => {
  assert.equal(isCertificateError(-202), true);
  assert.equal(isCertificateError(-501), true);
  assert.equal(isCertificateError(-105), false);
});

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, removeHandler: () => {}, handle: (channel, fn) => handlers.set(channel, fn) };
}

test('IPC rejects untrusted senders, other pages and malformed arguments', async () => {
  const ipcMain = fakeIpcMain();
  const ipc = createIpc(ipcMain, (event) => event.role ?? null);
  let calls = 0;
  ipc.handle('tabs:close', ['toolbar'], validators.tabId, () => { calls += 1; return 'ok'; });
  const invoke = ipcMain.handlers.get('tabs:close');

  assert.equal(invoke({ role: 'toolbar' }, 3), 'ok');
  assert.throws(() => invoke({}, 3), /untrusted sender/);
  assert.throws(() => invoke({ role: 'library' }, 3), /from the library page/);
  assert.throws(() => invoke({ role: 'toolbar' }, '3'), /invalid arguments/);
  assert.throws(() => invoke({ role: 'toolbar' }, 3, 'extra'), /invalid arguments/);
  assert.equal(calls, 1);
});

test('every IPC channel must name the pages allowed to call it', () => {
  const ipc = createIpc(fakeIpcMain(), () => 'toolbar');
  assert.throws(() => ipc.handle('x', validators.none, () => {}), /must name the pages/);
  assert.throws(() => ipc.handle('x', [], validators.none, () => {}), /must name the pages/);
  assert.throws(() => ipc.handle('x', ['website'], validators.none, () => {}), /must name the pages/);
});

test('each of the browser pages can call only the channels it needs', () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers(createIpc(ipcMain, (event) => event.role), {});
  // Arguments no validator accepts: an allowed page is stopped by validation, never reaching
  // a handler; a page that is not allowed is stopped before that.
  const junk = [Symbol('a'), Symbol('b'), Symbol('c')];
  const refused = (role, channel) => {
    try {
      ipcMain.handlers.get(channel)({ role }, ...junk);
    } catch (error) {
      return /from the \w+ page/.test(error.message);
    }
    return false;
  };
  const channels = [...ipcMain.handlers.keys()];
  const allowed = (role) => channels.filter((channel) => !refused(role, channel)).sort();

  assert.equal(channels.length, 47);
  assert.deepEqual(allowed('indicator'), ['recording:request-pause', 'recording:request-stop', 'ui:get-state']);
  assert.deepEqual(allowed('find'), ['find:close', 'find:query']);
  // The library tab shows text from websites: no recording, navigation or tab controls.
  assert.ok(allowed('library').every((channel) => /^(history|downloads|recordings|settings):|^tabs:open$/.test(channel)), allowed('library').join());
  // The toolbar has no access to files, settings or history.
  assert.ok(allowed('toolbar').every((channel) => !/^(history|downloads|recordings|settings):/.test(channel)), allowed('toolbar').join());
  assert.ok(allowed('toolbar').includes('recording:chunk'));
  // Every channel is open to exactly the pages listed, and to at least one of them.
  for (const channel of channels) {
    assert.ok(['toolbar', 'indicator', 'find', 'library'].some((role) => !refused(role, channel)), channel);
  }
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
