'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ContentBlocker, BlockedLog, REFRESH_AFTER_MS, MAX_HOSTS, MAX_ADDRESSES } = require('../../src/main/blocker');
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

test('a blocked request is an ad or a tracker by the list its filter came from', () => {
  const b = blocker();
  b.useFilters({ ad: '/adserver/*\n@@||cdn.example/pixel/ok.gif', tracker: '||tracker.example^\n/pixel/*' });
  const kind = (url) => b.classify({ url, resourceType: 'image', pageUrl: PAGE });
  assert.equal(kind('https://cdn.example/adserver/banner.png'), 'ad');
  assert.equal(kind('https://tracker.example/t.gif'), 'tracker');
  assert.equal(kind('https://cdn.example/pixel/1.gif'), 'tracker');
  assert.equal(kind('https://cdn.example/pixel/ok.gif'), null, 'an exception in one list applies to the other');
  assert.equal(kind('https://news.example/logo.png'), null);
  b.useFilters('/adserver/*');
  assert.equal(kind('https://cdn.example/adserver/banner.png'), 'ad', 'plain filter text is ads');
});

test('the saved lists remember which filters catch trackers; an older cache is downloaded again', async () => {
  const cacheDir = temp();
  const lists = ['https://lists.example/ads.txt', 'https://easylist.to/easylist/easyprivacy.txt'];
  const texts = { [lists[0]]: '/adserver/*', [lists[1]]: '||tracker.example^' };
  const first = new ContentBlocker({ cacheDir, lists, fetchText: async (url) => texts[url] });
  await first.update();
  const second = new ContentBlocker({ cacheDir, lists, fetchText: async () => { throw new Error('no network'); } });
  assert.equal(second.loadCache(), true);
  assert.equal(second.classify({ url: 'https://tracker.example/t.js', resourceType: 'script', pageUrl: PAGE }), 'tracker');
  assert.equal(second.classify({ url: 'https://cdn.example/adserver/a.js', resourceType: 'script', pageUrl: PAGE }), 'ad');

  const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, 'filters.json'), 'utf8'));
  fs.writeFileSync(path.join(cacheDir, 'filters.json'), JSON.stringify({ ...meta, format: undefined }));
  assert.equal(new ContentBlocker({ cacheDir, lists, fetchText: async () => '' }).loadCache(), false, 'a cache from 0.8 or before');
});

test('attached to a session, it reports each blocked request with its address, type and kind', () => {
  const b = blocker();
  b.useFilters({ ad: '/adserver/*', tracker: '||tracker.example^' });
  let handler;
  const reported = [];
  b.attach({ webRequest: { onBeforeRequest: (fn) => { handler = fn; } } }, { pageUrlOf: () => PAGE, isActive: () => true, onBlocked: (id, request) => reported.push([id, request]) });
  handler({ url: 'https://tracker.example/t.js', resourceType: 'script', webContentsId: 3 }, () => {});
  handler({ url: 'https://news.example/app.js', resourceType: 'script', webContentsId: 3 }, () => {});
  assert.deepEqual(reported, [[3, { url: 'https://tracker.example/t.js', resourceType: 'script', kind: 'tracker' }]]);
});

test('a tab lists what it blocked by host, most first, within limits', () => {
  const log = new BlockedLog();
  log.add({ url: 'https://metrics.example/c?id=1', resourceType: 'xhr', kind: 'tracker' });
  log.add({ url: 'https://ads.example/serve/banner.js', resourceType: 'script', kind: 'ad' });
  log.add({ url: 'https://ads.example/creative/728x90.png', resourceType: 'image', kind: 'ad' });
  log.add({ url: 'https://metrics.example/ad.gif', resourceType: 'image', kind: 'ad' });
  assert.equal(log.total, 4);
  assert.deepEqual(log.summary(), [
    { host: 'ads.example', kind: 'ad', count: 2, addresses: [{ path: '/serve/banner.js', type: 'script' }, { path: '/creative/728x90.png', type: 'image' }] },
    { host: 'metrics.example', kind: 'ad', count: 2, addresses: [{ path: '/c?id=1', type: 'request' }, { path: '/ad.gif', type: 'image' }] },
  ]);

  for (let i = 0; i < MAX_ADDRESSES + 5; i += 1) log.add({ url: `https://many.example/${i}`, resourceType: 'image', kind: 'tracker' });
  const many = log.summary()[0];
  assert.equal(many.count, MAX_ADDRESSES + 5, 'the count keeps going');
  assert.equal(many.addresses.length, MAX_ADDRESSES);
  for (let i = 0; i < MAX_HOSTS + 10; i += 1) log.add({ url: `https://h${i}.example/x`, resourceType: 'image', kind: 'ad' });
  assert.equal(log.summary().length, MAX_HOSTS);
  assert.equal(log.total, 4 + MAX_ADDRESSES + 5 + MAX_HOSTS + 10);
  log.clear();
  assert.deepEqual([log.total, log.summary()], [0, []]);
});
