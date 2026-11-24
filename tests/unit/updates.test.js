'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateService, compareVersions, updateMode, fetchLatestRelease } = require('../../src/main/updates');

test('versions compare by number, not as text', () => {
  assert.equal(compareVersions('0.10.0', '0.9.1'), 1);
  assert.equal(compareVersions('v0.5.0', '0.5.0'), 0);
  assert.equal(compareVersions('0.4.1', '0.5.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('how a copy updates depends on how it was installed', () => {
  const installed = (file) => file.endsWith('Uninstall Simple Browser.exe');
  assert.equal(updateMode({ isPackaged: false }), 'off');
  assert.equal(updateMode({ isPackaged: true, env: { PORTABLE_EXECUTABLE_DIR: 'C:\\x' }, exists: installed }), 'notify');
  assert.equal(updateMode({ isPackaged: true, env: {}, execPath: 'C:\\Apps\\Simple Browser\\Simple Browser.exe', exists: installed }), 'installer');
  assert.equal(updateMode({ isPackaged: true, env: {}, execPath: 'C:\\unpacked\\Simple Browser.exe', exists: () => false }), 'notify');
});

function fakeUpdater(outcome) {
  const updater = new EventEmitter();
  updater.installed = 0;
  updater.checkForUpdates = async () => {
    if (outcome === 'new') {
      updater.emit('update-available', { version: '0.6.0' });
      updater.emit('download-progress', { percent: 41.6 });
      updater.emit('update-downloaded', { version: '0.6.0' });
    } else if (outcome === 'none') {
      updater.emit('update-not-available', { version: '0.5.0' });
    } else {
      throw new Error('offline');
    }
  };
  updater.quitAndInstall = () => { updater.installed += 1; };
  return updater;
}

function service(options) {
  const notices = [];
  const changes = [];
  const updates = new UpdateService({ currentVersion: '0.5.0', notify: (text, kind = 'info') => notices.push([kind, text]), ...options });
  updates.on('change', (state) => changes.push(state.status));
  return { updates, notices, changes };
}

test('an installed copy downloads a new version and installs it on restart', async () => {
  const autoUpdater = fakeUpdater('new');
  const { updates, notices, changes } = service({ mode: 'installer', autoUpdater });
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  await updates.check();
  assert.deepEqual(changes, ['checking', 'downloading', 'downloading', 'ready']);
  assert.equal(updates.state.version, '0.6.0');
  assert.match(notices.at(-1)[1], /0\.6\.0 is ready/);
  assert.equal(updates.install(), null);
  assert.equal(autoUpdater.installed, 1);
  // A downloaded update is not checked for again.
  await updates.check();
  assert.equal(changes.at(-1), 'ready');
});

test('quiet automatic checks; the user hears the answer only when they asked', async () => {
  const quiet = service({ mode: 'installer', autoUpdater: fakeUpdater('none') });
  await quiet.updates.check();
  assert.equal(quiet.updates.state.status, 'up-to-date');
  assert.deepEqual(quiet.notices, []);
  await quiet.updates.check({ manual: true });
  assert.deepEqual(quiet.notices, [['info', 'Simple Browser is up to date.']]);

  const failing = service({ mode: 'installer', autoUpdater: fakeUpdater('fail') });
  await failing.updates.check();
  assert.equal(failing.updates.state.status, 'error');
  assert.deepEqual(failing.notices, []);
  await failing.updates.check({ manual: true });
  assert.match(failing.notices.at(-1)[1], /Could not check for updates: offline/);
});

test('a portable copy is told about a newer release and where to get it', async () => {
  const { updates, notices } = service({ mode: 'notify', fetchLatest: async () => ({ version: '0.6.0', url: 'https://github.com/o/r/releases/tag/v0.6.0' }) });
  await updates.check();
  assert.equal(updates.state.status, 'available');
  assert.match(notices[0][1], /0\.6\.0 is available/);
  assert.equal(updates.install(), 'https://github.com/o/r/releases/tag/v0.6.0');

  const same = service({ mode: 'notify', fetchLatest: async () => ({ version: '0.5.0', url: 'x' }) });
  await same.updates.check();
  assert.equal(same.updates.state.status, 'up-to-date');
  const older = service({ mode: 'notify', fetchLatest: async () => ({ version: '0.4.0', url: 'x' }) });
  await older.updates.check();
  assert.equal(older.updates.state.status, 'up-to-date');
});

test('automatic checks follow the setting; source runs never check', async () => {
  let fetched = 0;
  const off = service({ mode: 'notify', isEnabled: () => false, fetchLatest: async () => { fetched += 1; return { version: '9.0.0', url: 'x' }; } });
  await off.updates.check();
  assert.equal(fetched, 0);
  await off.updates.check({ manual: true });
  assert.equal(fetched, 1, 'a check the user asks for still runs');

  const source = service({ mode: 'off' });
  await source.updates.check({ manual: true });
  assert.equal(source.updates.state.status, 'idle');
  assert.match(source.notices[0][1], /running from source/);
});

test('the latest release is read from the GitHub API, with the page built from the known repository', async () => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([url, init.headers['User-Agent']]);
    return { ok: true, json: async () => ({ tag_name: 'v0.6.0', html_url: 'https://evil.example/' }) };
  };
  assert.deepEqual(await fetchLatestRelease(fetch, { owner: 'Mohanavadivelu', repo: 'browser' }), {
    version: '0.6.0', url: 'https://github.com/Mohanavadivelu/browser/releases/tag/v0.6.0',
  });
  assert.deepEqual(asked, [['https://api.github.com/repos/Mohanavadivelu/browser/releases/latest', 'Simple-Browser-Update-Check']]);
  await assert.rejects(fetchLatestRelease(async () => ({ ok: false, status: 404 }), { owner: 'o', repo: 'r' }), /404/);
});
