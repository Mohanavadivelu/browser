'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveInput, internalUrl } = require('../../src/main/security/navigation');
const { sanitizeSettings, pickEditable, Settings } = require('../../src/main/storage/settings');
const { stepZoom, hostKey, ZoomController } = require('../../src/main/zoom');
const { History } = require('../../src/main/storage/history');
const { DownloadManager } = require('../../src/main/download-manager');
const { buildContextMenuTemplate } = require('../../src/main/context-menu');
const { publicQualities, QUALITY } = require('../../src/main/recording/quality');
const {
  isSafeName, sanitizeBaseName, RecordingIndex, listRecordings, renameRecording, deleteRecording,
} = require('../../src/main/recording/library');
const { RecordingClock, Recorder } = require('../../src/main/recording/recorder');
const { recordingFileName, saveScreenshot } = require('../../src/main/recording/storage');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unit-'));

test('search uses the chosen engine, Google by default', () => {
  assert.match(resolveInput('cute cats').url, /^https:\/\/www\.google\.com\/search\?q=cute%20cats$/);
  assert.match(resolveInput('cute cats', 'duckduckgo').url, /^https:\/\/duckduckgo\.com\/\?q=/);
  assert.match(resolveInput('cats', 'bing').url, /^https:\/\/www\.bing\.com\/search\?q=cats$/);
  assert.match(resolveInput('cats', 'nonsense').url, /google\.com/);
});

test('internal pages are recognised, other simple-browser addresses are blocked', () => {
  assert.deepEqual(resolveInput('simple-browser://settings'), { ok: true, internal: 'settings' });
  assert.deepEqual(resolveInput('Simple-Browser://History/'), { ok: true, internal: 'history' });
  assert.equal(resolveInput('simple-browser://secret').reason, 'blocked-scheme');
  assert.equal(internalUrl('downloads'), 'simple-browser://downloads');
});

test('settings have safe defaults and reject bad values', () => {
  const defaults = sanitizeSettings(null);
  assert.equal(defaults.searchEngine, 'google');
  assert.equal(defaults.historyEnabled, false);
  assert.equal(defaults.restoreTabs, false);
  assert.equal(defaults.recordingQuality, 'medium');
  assert.equal(defaults.recordingFollowTab, true);
  assert.equal(defaults.homePage, '');

  const bad = sanitizeSettings({
    searchEngine: 'evil', recordingQuality: 'ultra', homePage: 'javascript:alert(1)',
    historyEnabled: 'yes', zoom: { 'a.com': 99, 'b.com': 1.25, 'c.com': 'big' },
    session: { urls: ['https://ok.example/', 'file:///C:/x'], active: 7 },
  });
  assert.equal(bad.searchEngine, 'google');
  assert.equal(bad.recordingQuality, 'medium');
  assert.equal(bad.homePage, '');
  assert.equal(bad.historyEnabled, false);
  assert.deepEqual(bad.zoom, { 'b.com': 1.25 });
  assert.deepEqual(bad.session, { urls: ['https://ok.example/'], active: 0 });
  assert.equal(sanitizeSettings({ homePage: ' https://example.com ' }).homePage, 'https://example.com/');
});

test('the settings page can only change the editable keys', () => {
  assert.deepEqual(
    pickEditable({ searchEngine: 'bing', bookmarks: [{ url: 'https://x.y' }], zoom: { a: 2 }, recordingFolder: 'C:\\x' }),
    { searchEngine: 'bing' },
  );
  assert.deepEqual(pickEditable(null), {});
});

test('settings persist to disk and reload', () => {
  const file = path.join(temp(), 'settings.json');
  const settings = new Settings(file);
  settings.update({ searchEngine: 'bing', historyEnabled: true });
  const reloaded = new Settings(file);
  reloaded.load();
  assert.equal(reloaded.data.searchEngine, 'bing');
  assert.equal(reloaded.data.historyEnabled, true);
});

test('zoom steps move through the standard levels and stop at the ends', () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.25, 1), 1.5);
  assert.equal(stepZoom(5, 1), 5);
  assert.equal(stepZoom(0.25, -1), 0.25);
  assert.equal(stepZoom(1.2, 1), 1.25);
  assert.equal(hostKey('https://Www.Example.com/path'), 'www.example.com');
  assert.equal(hostKey('file:///C:/x.html'), '');
});

function fakeTab(url, isPrivate = false) {
  let factor = 1;
  const contents = {
    isDestroyed: () => false,
    getURL: () => url,
    getZoomFactor: () => factor,
    setZoomFactor: (value) => { factor = value; },
  };
  return { isPrivate, view: { webContents: contents } };
}

test('zoom is remembered per site for regular tabs and kept in memory for private tabs', () => {
  const dir = temp();
  const settings = new Settings(path.join(dir, 's.json'));
  const controller = new ZoomController({ settings });

  const regular = fakeTab('https://site.example/a');
  assert.equal(controller.change(regular, 1), 1.1);
  assert.deepEqual(settings.data.zoom, { 'site.example': 1.1 });
  const sameSiteLater = fakeTab('https://site.example/b');
  controller.apply(sameSiteLater);
  assert.equal(sameSiteLater.view.webContents.getZoomFactor(), 1.1);
  assert.equal(controller.change(regular, 0), 1);
  assert.deepEqual(settings.data.zoom, {});

  const priv = fakeTab('https://private.example/', true);
  controller.change(priv, 1);
  assert.deepEqual(settings.data.zoom, {});
  assert.equal(controller.factorFor(priv, 'https://private.example/x'), 1.1);
  assert.equal(controller.change(fakeTab('file:///x.html'), 1), null);
});

test('history records, de-duplicates, searches, removes and clears', () => {
  const file = path.join(temp(), 'history.json');
  let now = 1_000_000;
  const history = new History(file, { now: () => now, max: 3 });
  history.add({ url: 'https://a.example/', title: 'Alpha' });
  now += 1000;
  history.add({ url: 'https://a.example/', title: 'Alpha page' });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].title, 'Alpha page');
  now += 60_000;
  history.add({ url: 'https://a.example/', title: 'Alpha later' });
  assert.equal(history.entries.length, 2);
  assert.equal(history.add({ url: 'javascript:alert(1)' }), null);
  history.add({ url: 'https://b.example/', title: 'Beta' });
  history.add({ url: 'https://c.example/', title: 'Gamma' });
  assert.equal(history.entries.length, 3);
  assert.deepEqual(history.list().map((e) => e.title), ['Gamma', 'Beta', 'Alpha later']);
  assert.deepEqual(history.list('beta').map((e) => e.title), ['Beta']);
  history.updateTitle('https://c.example/', 'Gamma 2');
  assert.equal(history.list('gamma 2').length, 1);

  history.flush();
  const reloaded = new History(file);
  reloaded.load();
  assert.equal(reloaded.entries.length, 3);

  assert.equal(history.remove(history.list()[0].id), true);
  assert.equal(history.entries.length, 2);
  history.clear();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

function fakeItem(name) {
  const item = new EventEmitter();
  let received = 0;
  let paused = false;
  Object.assign(item, {
    getFilename: () => name,
    getTotalBytes: () => 100,
    getReceivedBytes: () => received,
    getSavePath: () => (received ? `C:\\dl\\${name}` : ''),
    isPaused: () => paused,
    cancel: () => item.emit('done', {}, 'cancelled'),
    progress: (bytes) => { received = bytes; item.emit('updated', {}, 'progressing'); },
    finish: () => { received = 100; item.emit('done', {}, 'completed'); },
    setPaused: (value) => { paused = value; },
  });
  return item;
}

test('downloads report progress, completion and can be cancelled', () => {
  const manager = new DownloadManager();
  const events = [];
  manager.on('completed', (entry) => events.push(entry.filename));
  const first = fakeItem('a.pdf');
  const second = fakeItem('b.zip');
  const idA = manager.track(first);
  const idB = manager.track(second);
  first.progress(40);
  assert.equal(manager.list()[1].received, 40);
  assert.equal(manager.list()[0].filename, 'b.zip');
  first.finish();
  assert.deepEqual(events, ['a.pdf']);
  assert.equal(manager.list().find((d) => d.id === idA).state, 'completed');
  assert.equal(manager.pathOf(idA), 'C:\\dl\\a.pdf');
  assert.equal(manager.cancel(idA), false);
  second.progress(10);
  assert.equal(manager.cancel(idB), true);
  assert.equal(manager.list().find((d) => d.id === idB).state, 'cancelled');
});

function menuActions(log = []) {
  return {
    openInNewTab: (url) => log.push(['open', url]),
    copyText: (text) => log.push(['copy', text]),
    saveImage: (url) => log.push(['save', url]),
    copyImage: () => log.push(['copyImage']),
    edit: (name) => log.push(['edit', name]),
    searchFor: (text) => log.push(['search', text]),
    searchEngine: () => 'google',
    navigation: { canGoBack: () => true, canGoForward: () => false, back() {}, forward() {}, reload() {} },
  };
}

const labels = (template) => template.map((item) => item.label ?? '|');

test('context menu offers link, image, selection and navigation actions', () => {
  const log = [];
  const link = buildContextMenuTemplate({ linkURL: 'https://x.example/page' }, menuActions(log));
  assert.deepEqual(labels(link), ['Open link in new tab', 'Copy link address', '|', 'Back', 'Forward', 'Reload']);
  link[0].click();
  assert.deepEqual(log, [['open', 'https://x.example/page']]);
  assert.equal(link[4].enabled, false);

  const image = buildContextMenuTemplate({ mediaType: 'image', srcURL: 'https://x.example/a.png' }, menuActions());
  assert.deepEqual(labels(image).slice(0, 3), ['Save image as…', 'Copy image', 'Copy image address']);

  const selection = buildContextMenuTemplate({ selectionText: '  hello world  ' }, menuActions());
  assert.deepEqual(labels(selection).slice(0, 2), ['Copy', 'Search Google for “hello world”']);

  const editable = buildContextMenuTemplate({ isEditable: true, editFlags: { canPaste: false } }, menuActions());
  assert.deepEqual(labels(editable), ['Cut', 'Copy', 'Paste', 'Select all']);
  assert.equal(editable[2].enabled, false);
});

test('context menu never offers unsafe links or images', () => {
  const unsafe = buildContextMenuTemplate(
    { linkURL: 'javascript:alert(1)', mediaType: 'image', srcURL: 'file:///C:/secret.png' }, menuActions());
  assert.deepEqual(labels(unsafe), ['Back', 'Forward', 'Reload']);
  const noNav = buildContextMenuTemplate({}, { ...menuActions(), navigation: undefined });
  assert.deepEqual(noNav, []);
});

test('recording qualities describe themselves and cover every setting', () => {
  const qualities = publicQualities();
  assert.deepEqual(qualities.map((q) => q.key), Object.keys(QUALITY));
  assert.match(qualities.find((q) => q.key === 'low').description, /720p, 15 fps, about 12 MB per minute/);
  assert.match(qualities.find((q) => q.key === 'high').description, /1440p, 60 fps/);
});

test('recording clock excludes paused time', () => {
  let now = 0;
  const clock = new RecordingClock(() => now);
  clock.start();
  now = 3000;
  clock.pause();
  now = 10_000;
  assert.equal(clock.elapsed(), 3000);
  assert.equal(clock.paused, true);
  clock.resume();
  now = 12_000;
  assert.equal(clock.elapsed(), 5000);
  clock.reset();
  assert.equal(clock.elapsed(), 0);
});

function createRecorder(onSegment) {
  const folder = temp();
  const recorder = new Recorder({
    getFolder: () => folder,
    requestConsent: async () => ({ granted: true }),
    onChange: () => {},
    notify: () => {},
    onSegment,
  });
  return { recorder, folder };
}

test('pausing is reflected in the recorder info', async () => {
  const { recorder } = createRecorder();
  assert.equal(recorder.setPaused(true), false);
  await recorder.requestStart();
  assert.equal(recorder.info.paused, false);
  assert.equal(recorder.setPaused(true), true);
  assert.equal(recorder.info.paused, true);
  assert.equal(recorder.info.runningSince, null);
  recorder.setPaused(false);
  assert.equal(typeof recorder.info.runningSince, 'number');
  await recorder.finish();
  assert.deepEqual(recorder.info, { active: false, paused: false, baseMs: 0, runningSince: null });
});

test('a rollover keeps recording in a new part and reports every part', async () => {
  const segments = [];
  const { recorder, folder } = createRecorder((filePath, durationMs, final) => segments.push({ name: path.basename(filePath), final, ok: durationMs >= 0 }));
  await recorder.requestStart();
  assert.equal(recorder.consumeAuthorization(), true);
  recorder.write(new Uint8Array([1]));
  assert.deepEqual(await recorder.rollover(), { ok: true });
  assert.equal(recorder.active, true);
  assert.equal(recorder.consumeAuthorization(), true);
  recorder.write(new Uint8Array([2, 3]));
  await recorder.finish();

  assert.equal(segments.length, 2);
  assert.equal(segments[0].final, false);
  assert.equal(segments[1].final, true);
  assert.match(segments[1].name, /-part2\.webm$/);
  assert.deepEqual(fs.readdirSync(folder).length, 2);
  assert.deepEqual((await recorder.rollover()), { ok: false, reason: 'not-recording' });
});

test('file names for parts and screenshots never collide', () => {
  const date = new Date(2026, 10, 23, 2, 5, 9);
  assert.equal(recordingFileName(date, 1), 'recording-20261123-020509.webm');
  assert.equal(recordingFileName(date, 3), 'recording-20261123-020509-part3.webm');
  const folder = temp();
  const first = saveScreenshot(folder, Buffer.from([1]), date);
  const second = saveScreenshot(folder, Buffer.from([2]), date);
  assert.notEqual(first, second);
  assert.equal(path.basename(second), 'screenshot-20261123-020509-2.png');
});

test('recording file operations only touch plain files inside the folder', async () => {
  const folder = temp();
  assert.equal(isSafeName(folder, 'recording-1.webm'), true);
  for (const bad of ['..\\x.webm', '../x.webm', 'C:\\x.webm', 'x.exe', '.hidden.webm', 'a/b.webm', '', 'x.webm\u0000']) {
    assert.equal(isSafeName(folder, bad), false, bad);
  }
  assert.equal(sanitizeBaseName(' my:clip?* '), 'myclip');
  assert.equal(sanitizeBaseName('CON'), null);
  assert.equal(sanitizeBaseName('...'), null);

  const index = new RecordingIndex(path.join(folder, '..', `idx-${path.basename(folder)}.json`));
  fs.writeFileSync(path.join(folder, 'a.webm'), 'aaaa');
  fs.writeFileSync(path.join(folder, 'b.png'), 'bb');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'ignored');
  index.set('a.webm', 4200);
  const listed = listRecordings(folder, index);
  assert.deepEqual(listed.map((e) => e.name).sort(), ['a.webm', 'b.png']);
  assert.equal(listed.find((e) => e.name === 'a.webm').durationMs, 4200);
  assert.equal(listed.find((e) => e.name === 'b.png').type, 'image');

  assert.deepEqual(renameRecording(folder, 'a.webm', 'My clip', index), { ok: true, name: 'My clip.webm' });
  assert.equal(index.get('My clip.webm'), 4200);
  assert.equal(renameRecording(folder, 'My clip.webm', 'b', index).ok, true);
  assert.deepEqual(renameRecording(folder, 'b.webm', 'b', index), { ok: true, name: 'b.webm' });
  fs.writeFileSync(path.join(folder, 'c.webm'), 'cc');
  assert.equal(renameRecording(folder, 'b.webm', 'c', index).reason, 'exists');
  assert.equal(renameRecording(folder, 'x.exe', 'y', index).reason, 'invalid-name');
  assert.equal(renameRecording(folder, 'b.png', 'b', index).ok, true);

  const trashed = [];
  assert.equal((await deleteRecording(folder, 'b.png', async (p) => { trashed.push(p); fs.unlinkSync(p); }, index)).ok, true);
  assert.deepEqual(trashed, [path.join(folder, 'b.png')]);
  assert.equal((await deleteRecording(folder, '..\\evil.webm', async () => {}, index)).reason, 'invalid-name');
  assert.equal((await deleteRecording(folder, 'gone.webm', async () => {}, index)).reason, 'missing');
});

test('history skips jumps within a page but keeps single-page app page changes', () => {
  let now = 1_000_000;
  const history = new History(path.join(temp(), 'history.json'), { now: () => now });
  history.add({ url: 'https://docs.example/guide', title: 'Guide' });
  now += 60_000;
  history.add({ url: 'https://docs.example/guide#install', inPage: true });
  history.add({ url: 'https://docs.example/guide#usage', inPage: true });
  assert.deepEqual(history.entries.map((e) => e.url), ['https://docs.example/guide']);

  // A pushState change of path is a new page in a single-page app.
  history.add({ url: 'https://docs.example/api', inPage: true });
  assert.deepEqual(history.entries.map((e) => e.url), ['https://docs.example/guide', 'https://docs.example/api']);

  // A full load of the same address with a new #fragment still counts, as before.
  now += 60_000;
  history.add({ url: 'https://docs.example/api#top' });
  assert.equal(history.entries.length, 3);
});

test('a PDF is named after its page, without characters Windows forbids', () => {
  const { pdfFileName } = require('../../src/main/recording/library');
  assert.equal(pdfFileName('Q3: sales / plan'), 'Q3 sales plan.pdf');
  assert.equal(pdfFileName('  '), 'page.pdf');
  assert.equal(pdfFileName('CON'), 'page.pdf');
  assert.equal(pdfFileName(undefined), 'page.pdf');
  assert.ok(pdfFileName('x'.repeat(300)).length <= 104);
});

test('a recording can stop by itself after a chosen number of minutes, or never', () => {
  const { sanitizeSettings, STOP_AFTER_CHOICES } = require('../../src/main/storage/settings');
  assert.equal(sanitizeSettings({}).recordingStopAfter, 0);
  assert.equal(sanitizeSettings({ recordingStopAfter: 30 }).recordingStopAfter, 30);
  for (const bad of [7, -5, '30', 100000, null]) assert.equal(sanitizeSettings({ recordingStopAfter: bad }).recordingStopAfter, 0, String(bad));
  assert.deepEqual(STOP_AFTER_CHOICES.slice(0, 3), [0, 5, 10]);
});
