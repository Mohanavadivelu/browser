'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PermissionLog, CertificateLog, cookieMatches, cookieUrl, clearSiteData, bothOrigins } = require('../../src/main/site-info');
const { CookieClock, clearSummary, clearBrowsingData, sinceFor } = require('../../src/main/privacy');
const { History } = require('../../src/main/storage/history');
const { DownloadManager } = require('../../src/main/download-manager');
const { validators } = require('../../src/main/security/ipc-validate');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-privacy-test-'));
const HOUR = 60 * 60 * 1000;

// A session's cookie jar and clearing calls, as Electron offers them.
function fakeSession(cookies) {
  const jar = [...cookies];
  const calls = [];
  const session = {
    calls,
    jar,
    cookies: Object.assign(new EventEmitter(), {
      get: async () => jar.map((cookie) => ({ ...cookie })),
      remove: async (url, name) => {
        calls.push(['remove', url, name]);
        const at = jar.findIndex((cookie) => cookie.name === name && cookieUrl(cookie).startsWith(url.replace(/\/[^/]*$/, '')));
        if (at >= 0) jar.splice(at, 1);
      },
    }),
    clearData: async (options) => { calls.push(['clearData', options]); },
    clearStorageData: async (options) => { calls.push(['clearStorageData', options]); jar.length = 0; },
    clearCache: async () => { calls.push(['clearCache']); },
    getCacheSize: async () => 5000,
  };
  return session;
}

const cookie = (domain, name, extra = {}) => ({ domain, name, path: '/', secure: true, value: 'v', ...extra });

test('the permissions a page asked for are listed by name, and forgotten with the page', () => {
  const log = new PermissionLog();
  log.record(7, 'geolocation', false);
  log.record(7, 'fullscreen', true);
  log.record(7, 'fullscreen', false); // asked again and refused: it was still allowed once
  log.record(7, 'some-new-permission', false);
  assert.deepEqual(log.list(7), [
    { name: 'Your location', granted: false },
    { name: 'Full screen', granted: true },
    { name: 'some-new-permission', granted: false },
  ]);
  assert.deepEqual(log.list(8), []);
  log.clear(7);
  assert.deepEqual(log.list(7), []);
});

test('the certificate a site presented is kept by session and host, with what the panel shows', () => {
  const log = new CertificateLog();
  const regular = {};
  const other = {};
  log.record(regular, {
    hostname: 'docs.example.dev',
    certificate: { subjectName: 'docs.example.dev', issuerName: 'Example CA', validExpiry: 1_900_000_000, fingerprint: 'sha256/abc', data: 'PEM…' },
    verificationResult: 'net::OK',
  });
  assert.deepEqual(log.get(regular, 'docs.example.dev'), { subject: 'docs.example.dev', issuer: 'Example CA', validUntil: 1_900_000_000_000, fingerprint: 'sha256/abc', ok: true });
  assert.equal(log.get(other, 'docs.example.dev'), null);
  assert.equal(log.get(regular, 'other.example'), null);
});

test('a site\u2019s cookies are those sent to its host, never another site\u2019s', () => {
  assert.equal(cookieMatches('docs.example.dev', 'docs.example.dev'), true);
  assert.equal(cookieMatches('.example.dev', 'docs.example.dev'), true);
  assert.equal(cookieMatches('example.dev', 'docs.example.dev'), true);
  assert.equal(cookieMatches('other.example.dev', 'docs.example.dev'), false);
  assert.equal(cookieMatches('mple.dev', 'docs.example.dev'), false);
  assert.equal(cookieMatches('docs.example.dev', 'example.dev'), false);
  assert.deepEqual(bothOrigins('http://127.0.0.1:8080/page'), ['http://127.0.0.1:8080', 'https://127.0.0.1:8080']);
});

test('clearing a site removes its cookies and stored data, and leaves other sites alone', async () => {
  const session = fakeSession([cookie('docs.example.dev', 'sid'), cookie('.example.dev', 'pref'), cookie('mail.example.dev', 'mail'), cookie('news.example.org', 'n')]);
  const result = await clearSiteData(session, 'https://docs.example.dev/guide');
  assert.equal(result.cookies, 2);
  assert.deepEqual(session.jar.map((c) => c.name).sort(), ['mail', 'n']);
  const cleared = session.calls.find(([kind]) => kind === 'clearData')[1];
  assert.deepEqual(cleared.origins, ['https://docs.example.dev', 'http://docs.example.dev']);
  assert.ok(cleared.dataTypes.includes('localStorage') && cleared.dataTypes.includes('indexedDB') && !cleared.dataTypes.includes('cookies'));
});

test('cookie times: the first time a cookie was set is kept, across restarts', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'cookie-times.json');
  let now = 1000;
  const clock = new CookieClock({ filePath, now: () => now });
  const jar = new EventEmitter();
  clock.attach({ cookies: jar });
  jar.emit('changed', {}, cookie('a.example', 'x'), 'explicit', false);
  now = 5000;
  jar.emit('changed', {}, cookie('a.example', 'x'), 'overwrite', true); // replaced by a new value
  jar.emit('changed', {}, cookie('a.example', 'x'), 'explicit', false);
  assert.equal(clock.firstSeen(cookie('a.example', 'x')), 1000);
  jar.emit('changed', {}, cookie('b.example', 'y'), 'explicit', false);
  jar.emit('changed', {}, cookie('b.example', 'y'), 'expired', true);
  assert.equal(clock.firstSeen(cookie('b.example', 'y')), 0);
  clock.save();
  const again = new CookieClock({ filePath });
  again.load();
  assert.equal(again.firstSeen(cookie('a.example', 'x')), 1000);
  assert.equal(new CookieClock({ filePath: path.join(dir, 'missing.json') }).firstSeen(cookie('a.example', 'x')), 0);
});

function historyWith(times) {
  const history = new History(path.join(tempDir(), 'history.json'), { now: () => times.shift() });
  return history;
}

test('history: visits in a time range are counted and removed, older ones kept', () => {
  const now = 10 * 24 * HOUR;
  const stamps = [now - 3 * 24 * HOUR, now - 2 * HOUR, now - 10 * 60 * 1000];
  const history = historyWith([...stamps]);
  history.add({ url: 'https://old.example/', title: 'Old' });
  history.add({ url: 'https://today.example/', title: 'Today' });
  history.add({ url: 'https://now.example/', title: 'Now' });
  assert.equal(history.countSince(now - HOUR), 1);
  assert.equal(history.countSince(now - 24 * HOUR), 2);
  assert.equal(history.removeSince(now - 24 * HOUR), 2);
  assert.deepEqual(history.list().map((entry) => entry.url), ['https://old.example/']);
  assert.equal(history.removeSince(0), 1);
  assert.equal(history.list().length, 0);
});

// A finished download in the list, started at `startedAt`.
function finishedDownload(manager, name, startedAt) {
  const item = new EventEmitter();
  Object.assign(item, {
    getFilename: () => name, getURL: () => `https://files.example/${name}`, getTotalBytes: () => 1, getReceivedBytes: () => 1,
    getSavePath: () => `C:\\dl\\${name}`, isPaused: () => false, pause() {}, resume() {}, cancel() {},
  });
  const id = manager.track(item);
  manager.records.get(id).entry.startedAt = startedAt;
  item.emit('done', {}, 'completed');
  return id;
}

test('the downloads list: finished entries in the range go, running ones and older ones stay', () => {
  const manager = new DownloadManager();
  const now = 100 * HOUR;
  finishedDownload(manager, 'old.zip', now - 30 * HOUR);
  finishedDownload(manager, 'new.zip', now - HOUR / 2);
  const running = new EventEmitter();
  Object.assign(running, { getFilename: () => 'running.zip', getURL: () => 'https://files.example/r', getTotalBytes: () => 9, getReceivedBytes: () => 1, getSavePath: () => '', isPaused: () => false, pause() {}, resume() {}, cancel() {} });
  manager.track(running);
  assert.equal(manager.countFinishedSince(now - HOUR), 1);
  assert.equal(manager.removeFinishedSince(now - HOUR), 1);
  assert.deepEqual(manager.list().map((entry) => entry.filename).sort(), ['old.zip', 'running.zip']);
  assert.equal(manager.removeFinishedSince(0), 1);
  assert.deepEqual(manager.list().map((entry) => entry.filename), ['running.zip']);
});

test('clearing the last hour removes only cookies set in it, and what those sites stored', async () => {
  const now = 1000 * HOUR;
  const clock = new CookieClock({ now: () => now });
  const old = cookie('old.example', 'kept');
  const fresh = [cookie('.new.example', 'gone'), cookie('new.example', 'gone2'), cookie('other.example', 'gone3')];
  clock.seen(old, now - 5 * HOUR);
  for (const c of fresh) clock.seen(c, now - 10 * 60 * 1000);
  const unknown = cookie('before-times.example', 'kept2'); // set before the browser kept times
  const session = fakeSession([old, ...fresh, unknown]);
  const history = { countSince: () => 0, removeSince: () => 0 };
  const downloads = { countFinishedSince: () => 0, removeFinishedSince: () => 0 };
  const summary = await clearSummary({ range: 'hour', history, downloads, session, clock, now });
  assert.deepEqual({ cookies: summary.cookies, sites: summary.cookieSites, cache: summary.cacheBytes }, { cookies: 3, sites: 2, cache: 5000 });
  const done = await clearBrowsingData({ range: 'hour', what: { cookies: true }, history, downloads, session, clock, now });
  assert.equal(done.cookies, 3);
  assert.deepEqual(session.jar.map((c) => c.name).sort(), ['kept', 'kept2']);
  const cleared = session.calls.find(([kind]) => kind === 'clearData')[1];
  assert.deepEqual(cleared.origins.sort(), ['http://new.example', 'http://other.example', 'https://new.example', 'https://other.example']);
  assert.ok(!session.calls.some(([kind]) => kind === 'clearCache' || kind === 'clearStorageData'));
  assert.equal(clock.firstSeen(fresh[0]), 0);
});

test('clearing all time empties every site\u2019s data; the cache only when asked', async () => {
  const clock = new CookieClock();
  const session = fakeSession([cookie('a.example', 'x'), cookie('b.example', 'y')]);
  const removed = [];
  const history = { countSince: () => 4, removeSince: (since) => { removed.push(['history', since]); return 4; } };
  const downloads = { countFinishedSince: () => 1, removeFinishedSince: (since) => { removed.push(['downloads', since]); return 1; } };
  const done = await clearBrowsingData({ range: 'all', what: { history: true, cookies: true, cache: true, downloads: false }, history, downloads, session, clock, now: 5 });
  assert.deepEqual(removed, [['history', 0]]);
  assert.deepEqual({ history: done.history, cookies: done.cookies, sites: done.cookieSites, cache: done.cacheBytes, downloads: done.downloads }, { history: 4, cookies: 2, sites: 2, cache: 5000, downloads: 0 });
  assert.ok(session.calls.some(([kind, options]) => kind === 'clearStorageData' && options.storages.includes('cookies') && options.storages.includes('localstorage')));
  assert.ok(session.calls.some(([kind]) => kind === 'clearCache'));
  assert.equal(sinceFor('week', 8 * 24 * HOUR), 24 * HOUR);
  assert.throws(() => sinceFor('forever', 1));
});

test('the pages can only ask for a known range and known kinds of data', () => {
  assert.equal(validators.clearRange('day'), true);
  assert.equal(validators.clearRange('forever'), false);
  assert.equal(validators.clearRequest('all', { history: true, cache: false }), true);
  assert.equal(validators.clearRequest('all', { bookmarks: true }), false);
  assert.equal(validators.clearRequest('all', { history: 'yes' }), false);
  assert.equal(validators.clearRequest('all', {}), false);
  assert.equal(validators.clearRequest('hour'), false);
});
