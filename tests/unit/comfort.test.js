'use strict';

// 0.15: spell checking, the new tab page's tiles, history by day, dark pages, back up and restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { newTabTiles, topSites, hiddenFromHash, addHidden, MAX_HIDDEN } = require('../../src/main/new-tab');
const { DarkPages, DARK_CSS, LIGHTNESS, isLight } = require('../../src/main/dark-pages');
const { createBackup, parseBackup, restoreBackup, FORMAT } = require('../../src/main/backup');
const { buildContextMenuTemplate } = require('../../src/main/context-menu');
const { Settings, sanitizeSettings } = require('../../src/main/storage/settings');
const { History } = require('../../src/main/storage/history');
const { DownloadManager } = require('../../src/main/download-manager');
const { validators } = require('../../src/main/security/ipc-validate');
const bookmarkTree = require('../../src/main/bookmarks');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-comfort-'));
const visit = (url, time, title = '') => ({ url, time, title });

// ---------- New tab page ----------
test('the most visited pages come first, newest first among equals, without hidden ones', () => {
  const entries = [
    visit('https://a.example/', 1, 'A'),
    visit('https://b.example/', 2, 'B'),
    visit('https://a.example/#top', 3, 'A again'),
    visit('https://c.example/', 4, 'C'),
    visit('https://b.example/', 5, 'B new'),
    visit('https://hidden.example/', 6),
    visit('https://hidden.example/', 7),
    visit('https://hidden.example/', 8),
  ];
  const top = topSites(entries, new Set(['https://hidden.example/']));
  assert.deepEqual(top.map((tile) => tile.url), ['https://b.example/', 'https://a.example/', 'https://c.example/']);
  assert.equal(top[0].title, 'B new');
  assert.equal(top[1].title, 'A again');
});

test('the tiles show history only while it is on, never in private tabs, and bookmarks once', () => {
  const entries = [visit('https://a.example/', 1, 'A'), visit('https://a.example/', 2, 'A')];
  const barLinks = [
    { type: 'link', url: 'https://a.example/', title: 'A bookmark' },
    { type: 'link', url: 'https://d.example/', title: 'D'.repeat(100) },
    { type: 'link', url: 'javascript:alert(1)', title: 'Bad' },
  ];
  const on = newTabTiles({ entries, historyOn: true, isPrivate: false, barLinks, hidden: [] });
  assert.deepEqual(on.top.map((tile) => tile.url), ['https://a.example/']);
  assert.deepEqual(on.bookmarks.map((tile) => tile.url), ['https://d.example/']);
  assert.equal(on.bookmarks[0].title.length, 60);
  const off = newTabTiles({ entries, historyOn: false, isPrivate: false, barLinks, hidden: [] });
  assert.deepEqual(off.top, []);
  assert.deepEqual(off.bookmarks.map((tile) => tile.url), ['https://a.example/', 'https://d.example/']);
  const privateTab = newTabTiles({ entries, historyOn: true, isPrivate: true, barLinks, hidden: [] });
  assert.deepEqual(privateTab.top, []);
});

test('a removed tile is read from the page address only when it is a web address', () => {
  assert.equal(hiddenFromHash(`#hide=${encodeURIComponent('https://a.example/x?y=1')}`), 'https://a.example/x?y=1');
  assert.equal(hiddenFromHash(`#hide=${encodeURIComponent('file:///C:/secret')}`), null);
  assert.equal(hiddenFromHash('#hide=%E0%A4%A'), null);
  assert.equal(hiddenFromHash('#other'), null);
  assert.equal(hiddenFromHash(''), null);
  const many = Array.from({ length: MAX_HIDDEN + 5 }, (_, i) => `https://s${i}.example/`);
  const kept = addHidden(many, 'https://new.example/');
  assert.equal(kept.length, MAX_HIDDEN);
  assert.equal(kept.at(-1), 'https://new.example/');
  assert.deepEqual(addHidden(['https://a.example/'], 'https://a.example/'), ['https://a.example/']);
});

test('the new tab page script builds tiles from its address and hides a removed one', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/newtab.js'), 'utf8');
  assert.match(source, /location\.hash = `hide=\$\{encodeURIComponent\(entry\.url\)\}`/);
  // Only http(s) tiles are drawn, and text goes in as text.
  assert.match(source, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
  assert.doesNotMatch(source, /innerHTML/);
});

// ---------- Spell checking ----------
test('a misspelled word offers up to five suggestions and adding it to the dictionary', () => {
  const replaced = [];
  const added = [];
  const actions = {
    edit: () => {},
    replaceMisspelling: (word) => replaced.push(word),
    addToDictionary: (word) => added.push(word),
  };
  const params = { isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help', 'hero', 'halo', 'helm', 'hell'], editFlags: {} };
  const items = buildContextMenuTemplate(params, actions);
  const labels = items.map((item) => item.label ?? '---');
  assert.deepEqual(labels.slice(0, 7), ['hello', 'help', 'hero', 'halo', 'helm', 'Add to dictionary', '---']);
  assert.ok(labels.includes('Paste'));
  items[0].click();
  items[5].click();
  assert.deepEqual(replaced, ['hello']);
  assert.deepEqual(added, ['helo']);

  const none = buildContextMenuTemplate({ ...params, dictionarySuggestions: [] }, actions);
  assert.equal(none[0].label, 'No spelling suggestions');
  assert.equal(none[0].enabled, false);
  // The browser's own text boxes have no spelling actions.
  const own = buildContextMenuTemplate(params, { edit: () => {} });
  assert.equal(own[0].label, 'Cut');
});

test('spell checking is on unless turned off, and dark pages off unless turned on', () => {
  const defaults = sanitizeSettings({});
  assert.equal(defaults.spellcheck, true);
  assert.equal(defaults.darkPages, false);
  assert.deepEqual(defaults.darkPagesLight, []);
  assert.deepEqual(defaults.newTabHidden, []);
  const set = sanitizeSettings({ spellcheck: false, darkPages: true, darkPagesLight: ['a.example', 'bad host!', 5], newTabHidden: ['https://a.example/', 'file:///x', 'x'.repeat(500)] });
  assert.equal(set.spellcheck, false);
  assert.equal(set.darkPages, true);
  assert.deepEqual(set.darkPagesLight, ['a.example']);
  assert.deepEqual(set.newTabHidden, ['https://a.example/']);
});

// ---------- History by day ----------
test('a day of history can be deleted without touching the days around it', () => {
  const history = new History(null);
  history.entries = [visit('https://a.example/', 100), visit('https://b.example/', 200), visit('https://c.example/', 300)]
    .map((entry, index) => ({ ...entry, id: index + 1 }));
  history.flush = () => {};
  assert.equal(history.removeBetween(200, 300), 1);
  assert.deepEqual(history.entries.map((entry) => entry.url), ['https://a.example/', 'https://c.example/']);
  assert.equal(history.removeBetween(1000, 2000), 0);
  assert.equal(validators.timeRange(0, 86_400_000), true);
  assert.equal(validators.timeRange(5, 5), false);
  assert.equal(validators.timeRange(-1, 5), false);
  assert.equal(validators.timeRange('0', 5), false);
});

test('the History page groups by day and asks before deleting one', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/library-history.js'), 'utf8');
  assert.match(source, /'Today'/);
  assert.match(source, /'Yesterday'/);
  assert.match(source, /api\.history\.removeRange\(day\.start, day\.end\)/);
  // One click shows the question; only its Delete button deletes.
  assert.match(source, /button\(searching \? 'Delete these' : 'Delete this day', ask/);
});

// ---------- Dark pages ----------
function fakeContents(url, lightness) {
  const contents = new EventEmitter();
  Object.assign(contents, {
    url,
    lightness,
    css: new Map(),
    nextKey: 1,
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    getURL: () => contents.url,
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      assert.equal(scripts.length, 1);
      return contents.lightness;
    },
    insertCSS: async (css) => {
      const key = `k${contents.nextKey++}`;
      contents.css.set(key, css);
      return key;
    },
    removeInsertedCSS: async (key) => { contents.css.delete(key); },
  });
  return contents;
}

test('light pages are darkened, dark ones and sites kept light are not', async () => {
  let enabled = true;
  const light = new Set();
  const dark = new DarkPages({ enabled: () => enabled, keptLight: (host) => light.has(host) });
  const page = fakeContents('https://light.example/', 0.95);
  assert.equal(await dark.apply(page), true);
  assert.equal(page.css.size, 1);
  assert.equal([...page.css.values()][0], DARK_CSS);
  assert.equal(await dark.apply(page), true, 'applied again');
  assert.equal(page.css.size, 1, 'one style only');
  assert.equal(dark.isDarkened(page), true);

  // Its styles loaded and it is dark after all.
  page.lightness = 0.1;
  assert.equal(await dark.apply(page), false);
  assert.equal(page.css.size, 0);

  page.lightness = 0.9;
  await dark.apply(page);
  light.add('light.example');
  assert.equal(await dark.apply(page), false);
  assert.equal(page.css.size, 0);
  light.clear();
  await dark.apply(page);
  enabled = false;
  await dark.apply(page);
  assert.equal(page.css.size, 0);
  assert.equal(dark.isDarkened(page), false);

  enabled = true;
  assert.equal(await dark.apply(fakeContents('file:///C:/x.html', 1)), false);
  assert.equal(await dark.apply(fakeContents('https://dark.example/', 0.05)), false);
});

test('dark pages: both load events at once leave one style, and a new page starts without it', async () => {
  const dark = new DarkPages({ enabled: () => true, keptLight: () => false });
  const page = fakeContents('https://light.example/', 1);
  dark.watch(page);
  await Promise.all([dark.apply(page), dark.apply(page)]);
  assert.equal(page.css.size, 1);
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(dark.isDarkened(page), false);
});

test('how light a page is: its background, else its canvas and text', () => {
  assert.equal(isLight(0.9), true);
  assert.equal(isLight(0.2), false);
  assert.equal(isLight(null), false);
  assert.equal(isLight(Number.NaN), false);
  const run = ({ body, root, scheme = 'normal', text = 'rgb(0, 0, 0)' }) => {
    const styles = new Map([['body', { backgroundColor: body, color: text }], ['html', { backgroundColor: root, colorScheme: scheme }]]);
    const document = { body: 'body', documentElement: 'html' };
    // eslint-disable-next-line no-new-func
    return new Function('document', 'getComputedStyle', `return ${LIGHTNESS};`)(document, (element) => styles.get(element));
  };
  assert.ok(run({ body: 'rgb(255, 255, 255)', root: 'rgba(0, 0, 0, 0)' }) > 0.99);
  assert.ok(run({ body: 'rgb(255 255 255 / 0.9)', root: 'rgba(0, 0, 0, 0)' }) > 0.99);
  assert.ok(run({ body: 'rgba(0, 0, 0, 0)', root: 'rgb(20, 20, 20)' }) < 0.1);
  assert.equal(run({ body: 'rgba(0, 0, 0, 0)', root: 'rgba(0, 0, 0, 0)' }), 1);
  assert.equal(run({ body: 'rgba(0, 0, 0, 0)', root: 'rgba(0, 0, 0, 0)', scheme: 'light dark' }), 0);
  assert.ok(run({ body: 'rgba(0, 0, 0, 0)', root: 'rgba(0, 0, 0, 0)', text: 'rgb(240, 240, 240)' }) < 0.1);
  // The darkening style's own canvas colour is not the page's.
  assert.ok(run({ body: 'rgba(0, 0, 0, 0)', root: 'rgb(255, 255, 254)', text: 'rgb(230, 230, 230)' }) < 0.2);
});

// ---------- Back up and restore ----------
function stores(dir) {
  const settings = new Settings(path.join(dir, 'settings.json'));
  settings.load();
  const history = new History(path.join(dir, 'history.json'));
  history.load();
  const downloads = new DownloadManager({ storePath: path.join(dir, 'downloads.json') });
  return { settings, history, downloads };
}

const finishedDownload = (name) => ({
  filename: name, path: path.join(os.tmpdir(), name), url: `https://files.example/${name}`, state: 'completed',
  received: 10, total: 10, startedAt: 1, finishedAt: 2,
});

test('a backup holds bookmarks, settings, pinned tabs and downloads, and history only when asked', () => {
  const dir = tempDir();
  try {
    const { settings, history, downloads } = stores(dir);
    const tree = bookmarkTree.addLink(settings.data.bookmarks, 'bar', { title: 'A', url: 'https://a.example/' }).tree;
    settings.update({ bookmarks: tree, searchEngine: 'duckduckgo', pinnedTabs: ['https://mail.example/'], darkPages: true, darkPagesLight: ['x.example'] });
    history.entries = [{ id: 1, url: 'https://a.example/', title: 'A', time: 5 }];
    downloads.importEntries([finishedDownload('a.zip')]);

    const without = createBackup({ settings: settings.data, history, downloads, includeHistory: false, appVersion: '0.15.0', now: 42 });
    assert.equal(without.format, FORMAT);
    assert.equal(without.history, null);
    assert.equal(without.settings.searchEngine, 'duckduckgo');
    assert.deepEqual(without.settings.darkPagesLight, ['x.example']);
    assert.equal(without.settings.session, undefined, 'the open tabs are not backed up');
    assert.equal(without.settings.recordingFolder, undefined, 'nor folders of this computer');
    assert.deepEqual(without.pinnedTabs, ['https://mail.example/']);
    assert.equal(without.downloads.length, 1);
    assert.equal(without.downloads[0].id, undefined);

    const withHistory = createBackup({ settings: settings.data, history, downloads, includeHistory: true, appVersion: '0.15.0' });
    assert.deepEqual(withHistory.history, [{ url: 'https://a.example/', title: 'A', time: 5 }]);

    const parsed = parseBackup(JSON.stringify(withHistory));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.counts, { bookmarks: 1, folders: 0, settings: Object.keys(parsed.backup.settings).length, pinnedTabs: 1, downloads: 1, history: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup file is checked as strictly as the browser files', () => {
  assert.deepEqual(parseBackup('not json'), { ok: false, reason: 'not-json' });
  assert.deepEqual(parseBackup('{"format":"other"}'), { ok: false, reason: 'not-a-backup' });
  assert.deepEqual(parseBackup(JSON.stringify({ format: FORMAT, version: 99 })), { ok: false, reason: 'newer-version' });
  assert.equal(parseBackup('x'.repeat(21 * 1024 * 1024)).reason, 'too-large');
  const hostile = {
    format: FORMAT,
    version: 1,
    bookmarks: { bar: { children: [{ type: 'link', title: 'Bad', url: 'javascript:alert(1)' }] } },
    settings: { homePage: 'file:///C:/Windows', searchEngine: 'evil', session: { urls: ['https://x.example/'] }, recordingFolder: 'C:\\Windows' },
    pinnedTabs: ['https://ok.example/', 'file:///C:/x'],
    downloads: [finishedDownload('ok.zip'), { ...finishedDownload('bad.zip'), url: 'file:///C:/x' }, { ...finishedDownload('run.zip'), state: 'progressing' }],
    history: [visit('https://ok.example/', 5), visit('javascript:1', 6), visit('https://no-time.example/', 'x')],
  };
  const parsed = parseBackup(JSON.stringify(hostile));
  assert.equal(parsed.ok, true);
  assert.equal(bookmarkTree.links(parsed.backup.bookmarks).length, 0);
  assert.equal(parsed.backup.settings.homePage, '');
  assert.notEqual(parsed.backup.settings.searchEngine, 'evil');
  assert.equal(parsed.backup.settings.session, undefined);
  assert.equal(parsed.backup.settings.recordingFolder, undefined);
  assert.deepEqual(parsed.backup.pinnedTabs, ['https://ok.example/']);
  assert.deepEqual(parsed.backup.downloads.map((entry) => entry.filename), ['ok.zip']);
  assert.deepEqual(parsed.backup.history.map((entry) => entry.url), ['https://ok.example/']);
});

test('restoring replaces bookmarks and settings and adds pinned tabs, downloads and history', () => {
  const from = tempDir();
  const to = tempDir();
  try {
    const source = stores(from);
    const tree = bookmarkTree.addLink(source.settings.data.bookmarks, 'bar', { title: 'Saved', url: 'https://saved.example/' }).tree;
    source.settings.update({ bookmarks: tree, searchEngine: 'bing', pinnedTabs: ['https://pinned.example/', 'https://open.example/'] });
    source.history.entries = [{ id: 1, url: 'https://old.example/', title: 'Old', time: 10 }];
    source.downloads.importEntries([finishedDownload('a.zip')]);
    const parsed = parseBackup(JSON.stringify(createBackup({ ...source, settings: source.settings.data, includeHistory: true, appVersion: '0.15.0' })));

    const target = stores(to);
    const mine = bookmarkTree.addLink(target.settings.data.bookmarks, 'bar', { title: 'Mine', url: 'https://mine.example/' }).tree;
    target.settings.update({ bookmarks: mine });
    target.history.entries = [{ id: 1, url: 'https://new.example/', title: 'New', time: 20 }];
    target.downloads.importEntries([finishedDownload('a.zip')]);
    const opened = [];
    const openPinned = (urls) => {
      const missing = urls.filter((url) => url !== 'https://open.example/');
      opened.push(...missing);
      return missing.length;
    };

    // Only what is ticked.
    const some = restoreBackup(parsed.backup, { bookmarks: false, settings: true }, { ...target, openPinned });
    assert.deepEqual(Object.keys(some), ['settings']);
    assert.equal(target.settings.data.searchEngine, 'bing');
    assert.deepEqual(bookmarkTree.links(target.settings.data.bookmarks).map((link) => link.url), ['https://mine.example/']);

    const done = restoreBackup(parsed.backup, { bookmarks: true, pinnedTabs: true, downloads: true, history: true }, { ...target, openPinned });
    assert.deepEqual(bookmarkTree.links(target.settings.data.bookmarks).map((link) => link.url), ['https://saved.example/']);
    assert.equal(done.bookmarks, 1);
    assert.deepEqual(opened, ['https://pinned.example/']);
    assert.equal(done.pinnedTabs, 1);
    assert.equal(done.downloads, 0, 'already listed');
    assert.equal(done.history, 1);
    assert.deepEqual(target.history.entries.map((entry) => [entry.id, entry.url]), [[1, 'https://old.example/'], [2, 'https://new.example/']]);
    // Restoring the same history twice adds nothing.
    assert.equal(target.history.importEntries(parsed.backup.history), 0);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('downloads from a backup are listed as finished, without their old numbers', () => {
  const manager = new DownloadManager({});
  assert.equal(manager.importEntries([finishedDownload('a.zip'), { ...finishedDownload('b.zip'), state: 'interrupted' }]), 2);
  const listed = manager.exportEntries();
  assert.deepEqual(listed.map((entry) => [entry.filename, entry.state]), [['a.zip', 'completed'], ['b.zip', 'interrupted']]);
  assert.ok(listed.every((entry) => entry.id === undefined && entry.isPrivate === undefined));
});

test('restore is asked for by part, and only for the parts a backup has', () => {
  assert.equal(validators.backupParts({ bookmarks: true, history: false }), true);
  assert.equal(validators.backupParts({}), false);
  assert.equal(validators.backupParts({ cookies: true }), false);
  assert.equal(validators.backupParts({ bookmarks: 'yes' }), false);
  assert.equal(validators.backupParts(null), false);
  assert.equal(validators.backupParts([true]), false);
});
