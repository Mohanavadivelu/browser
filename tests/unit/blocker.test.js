'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ContentBlocker, REFRESH_AFTER_MS } = require('../../src/main/blocker');
const { sanitizeSettings } = require('../../src/main/storage/settings');

const FILTERS = [
  '||tracker.example^',
  '/adserver/*',
  '||ads.example^$third-party',
  '@@||tracker.example/consent.js',
].join('\n');
const PAGE = 'https://news.example/article';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-blocker-'));

function blocker(options = {}) {
  return new ContentBlocker({ cacheDir: temp(), fetchText: async () => FILTERS, ...options });
}

test('requests on the lists are blocked; the page itself and exceptions are not', () => {
  const b = blocker();
  b.useFilters(FILTERS);
  const check = (url, resourceType = 'script', pageUrl = PAGE) => b.shouldBlock({ url, resourceType, pageUrl });
  assert.equal(check('https://tracker.example/t.js'), true);
  assert.equal(check('https://cdn.example/adserver/banner.png', 'image'), true);
  assert.equal(check('https://news.example/app.js'), false);
  assert.equal(check('https://tracker.example/consent.js'), false, 'exception rule');
  assert.equal(check('https://tracker.example/', 'mainFrame'), false, 'a page someone opens is never blocked');
  assert.equal(check('https://ads.example/x.js'), true, 'third-party');
  assert.equal(check('https://ads.example/x.js', 'script', 'https://ads.example/'), false, 'first-party');
  assert.equal(check('data:text/plain,adserver'), false);
});

test('nothing is blocked before the lists are loaded', () => {
  const b = blocker();
  assert.equal(b.ready, false);
  assert.equal(b.shouldBlock({ url: 'https://tracker.example/t.js', resourceType: 'script', pageUrl: PAGE }), false);
});

test('downloaded lists are compiled, saved, and loaded again on the next start', async () => {
  const cacheDir = temp();
  let now = 1_000_000;
  const fetched = [];
  const first = new ContentBlocker({ cacheDir, now: () => now, lists: ['https://lists.example/a.txt'], fetchText: async (url) => { fetched.push(url); return FILTERS; } });
  assert.equal(first.loadCache(), false);
  assert.equal(first.stale, true);
  await first.update();
  assert.deepEqual(fetched, ['https://lists.example/a.txt']);
  assert.equal(first.stale, false);

  const second = new ContentBlocker({ cacheDir, now: () => now, lists: ['https://lists.example/a.txt'], fetchText: async () => { throw new Error('no network'); } });
  assert.equal(second.loadCache(), true);
  assert.equal(second.shouldBlock({ url: 'https://tracker.example/t.js', resourceType: 'script', pageUrl: PAGE }), true);
  now += REFRESH_AFTER_MS + 1;
  assert.equal(second.stale, true, 'old lists are refreshed');

  // A cache made for other lists is not used.
  const other = new ContentBlocker({ cacheDir, lists: ['https://lists.example/b.txt'], fetchText: async () => FILTERS });
  assert.equal(other.loadCache(), false);
});

test('a failed download keeps the lists already loaded', async () => {
  const b = blocker({ fetchText: async () => '' });
  b.useFilters(FILTERS);
  await assert.rejects(b.update(), /unexpected list/);
  assert.equal(b.shouldBlock({ url: 'https://tracker.example/t.js', resourceType: 'script', pageUrl: PAGE }), true);
});

test('updates that overlap share one download', async () => {
  let downloads = 0;
  const b = blocker({ lists: ['https://lists.example/a.txt'], fetchText: async () => { downloads += 1; return FILTERS; } });
  await Promise.all([b.update(), b.update()]);
  assert.equal(downloads, 1);
});

test('attached to a session, it cancels matching requests only where blocking is on', () => {
  const b = blocker();
  b.useFilters(FILTERS);
  let handler;
  const session = { webRequest: { onBeforeRequest: (fn) => { handler = fn; } } };
  const blockedIn = [];
  let active = true;
  b.attach(session, { pageUrlOf: () => PAGE, isActive: () => active, onBlocked: (id) => blockedIn.push(id) });
  const decide = (url, resourceType = 'script') => {
    let result;
    handler({ url, resourceType, webContentsId: 7, referrer: '' }, (answer) => { result = answer; });
    return result.cancel;
  };
  assert.equal(decide('https://tracker.example/t.js'), true);
  assert.equal(decide('https://news.example/app.js'), false);
  assert.deepEqual(blockedIn, [7]);
  active = false;
  assert.equal(decide('https://tracker.example/t.js'), false, 'turned off, or a site the user allowed');
});

test('blocking is on by default and allowed sites are plain host names', () => {
  assert.equal(sanitizeSettings({}).blockTrackers, true);
  assert.equal(sanitizeSettings({ blockTrackers: false }).blockTrackers, false);
  assert.deepEqual(sanitizeSettings({ blockerAllowedSites: ['news.example', 'news.example', 'BAD HOST', 5, 'a.b.example'] }).blockerAllowedSites,
    ['news.example', 'a.b.example']);
});
