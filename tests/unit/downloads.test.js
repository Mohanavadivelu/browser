'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DownloadManager, sanitizeEntry } = require('../../src/main/download-manager');
const { guardDownload } = require('../../src/main/security/downloads');
const { classifyVideos, nameFromUrl } = require('../../src/main/page-videos');
const { buildContextMenuTemplate } = require('../../src/main/context-menu');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A stand-in for Electron's DownloadItem, driven by the test.
function fakeItem(name, { url = `https://files.example/${name}`, total = 1000, savePath = `C:\\dl\\${name}`, resumable = true } = {}) {
  const item = new EventEmitter();
  let received = 0;
  let paused = false;
  let state = 'progressing';
  let chosen = savePath;
  Object.assign(item, {
    calls: [],
    getFilename: () => name,
    getURL: () => url,
    getURLChain: () => [url],
    getMimeType: () => 'application/octet-stream',
    getETag: () => '"v1"',
    getLastModifiedTime: () => 'Wed, 01 Jan 2025 00:00:00 GMT',
    getStartTime: () => 1700000000,
    getTotalBytes: () => total,
    getReceivedBytes: () => received,
    getSavePath: () => chosen,
    setSavePath: (value) => { chosen = value; },
    getCurrentBytesPerSecond: () => (paused ? 0 : 500),
    getState: () => state,
    isPaused: () => paused,
    canResume: () => resumable,
    pause: () => { item.calls.push('pause'); paused = true; item.emit('updated', {}, 'progressing'); },
    resume: () => { item.calls.push('resume'); paused = false; state = 'progressing'; item.emit('updated', {}, 'progressing'); },
    cancel: () => { item.calls.push('cancel'); state = 'cancelled'; item.emit('done', {}, 'cancelled'); },
    progress: (bytes) => { received = bytes; item.emit('updated', {}, 'progressing'); },
    finish: () => { received = total; state = 'completed'; item.emit('done', {}, 'completed'); },
    fail: () => { state = 'interrupted'; item.emit('done', {}, 'interrupted'); },
    interrupted: () => { state = 'interrupted'; },
  });
  return item;
}

const stateOf = (manager, id) => manager.list().find((entry) => entry.id === id).state;
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dl-test-'));

test('only so many downloads run at once; the rest wait and start in order as others finish', async () => {
  const manager = new DownloadManager({ maxActive: () => 2 });
  const items = ['a', 'b', 'c', 'd'].map((name) => fakeItem(name));
  const ids = items.map((item) => manager.track(item));
  for (const item of items) item.progress(10);
  await tick();
  assert.deepEqual(ids.map((id) => stateOf(manager, id)), ['progressing', 'progressing', 'queued', 'queued']);
  assert.deepEqual(items[2].calls, ['pause']);
  items[0].finish();
  assert.deepEqual(ids.map((id) => stateOf(manager, id)), ['completed', 'progressing', 'progressing', 'queued']);
  assert.deepEqual(items[2].calls, ['pause', 'resume']);
  // Pausing one makes room for the next; Resume runs it at once, over the limit.
  manager.pause(ids[1]);
  assert.equal(stateOf(manager, ids[3]), 'progressing');
  assert.equal(manager.resume(ids[1]), true);
  assert.equal(manager.brief().active, 3);
});

test('a waiting download can be started now, paused and resumed', async () => {
  const manager = new DownloadManager({ maxActive: () => 1 });
  const first = fakeItem('first.zip');
  const second = fakeItem('second.zip');
  manager.track(first);
  const id = manager.track(second);
  first.progress(1);
  second.progress(1);
  await tick();
  assert.equal(stateOf(manager, id), 'queued');
  assert.equal(manager.resume(id), true);
  assert.equal(stateOf(manager, id), 'progressing');
  assert.equal(manager.pause(id), true);
  assert.equal(stateOf(manager, id), 'paused');
  assert.equal(manager.list().find((entry) => entry.id === id).speed, 0);
  assert.equal(manager.pause(id), false);
});

test('a failed download resumes if it can, and otherwise starts over in the same file', () => {
  const started = [];
  const manager = new DownloadManager({ startDownload: (url) => started.push(url) });
  const item = fakeItem('data.csv');
  const id = manager.track(item);
  item.progress(400);
  item.fail();
  assert.equal(stateOf(manager, id), 'interrupted');
  assert.equal(manager.list()[0].retry, 'resume');
  assert.equal(manager.retry(id), true);
  assert.deepEqual(item.calls, ['resume']);

  const stubborn = fakeItem('stuck.csv', { resumable: false });
  const stuckId = manager.track(stubborn);
  stubborn.fail();
  assert.equal(manager.list()[0].retry, 'restart');
  assert.equal(manager.retry(stuckId), true);
  assert.deepEqual(started, ['https://files.example/stuck.csv']);
  // The new download is adopted by the same row and goes into the same file, without a dialog.
  const again = fakeItem('stuck.csv', { savePath: '' });
  assert.equal(manager.presetPath(again), 'C:\\dl\\stuck.csv');
  again.setSavePath(manager.presetPath(again));
  assert.equal(manager.track(again), stuckId);
  again.finish();
  assert.equal(manager.list().length, 2);
  assert.equal(stateOf(manager, stuckId), 'completed');
});

test('a private download is never saved and cannot start over once its tab is gone', () => {
  const dir = tempDir();
  const storePath = path.join(dir, 'downloads.json');
  const manager = new DownloadManager({ storePath, startDownload: () => {} });
  const secret = fakeItem('secret.pdf', { resumable: false });
  const id = manager.track(secret, { isPrivate: true });
  manager.track(fakeItem('public.pdf'));
  secret.fail();
  assert.equal(manager.list().find((entry) => entry.id === id).retry, null);
  assert.equal(manager.retry(id), false);
  manager.save();
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.deepEqual(saved.entries.map((entry) => entry.filename), ['public.pdf']);
  assert.ok(!('isPrivate' in saved.entries[0]) && !('id' in saved.entries[0]));
});

test('unfinished downloads come back after a restart and resume from the bytes already saved', async () => {
  const dir = tempDir();
  const storePath = path.join(dir, 'downloads.json');
  const partial = path.join(dir, 'big.iso.part');
  fs.writeFileSync(partial, Buffer.alloc(700, 1)); // more than was counted when the list was saved
  const before = new DownloadManager({ storePath });
  const running = fakeItem('big.iso.part', { savePath: partial });
  const paused = fakeItem('later.zip', { savePath: path.join(dir, 'later.zip') });
  before.track(running);
  before.track(paused);
  running.progress(600);
  paused.progress(5);
  before.pause(2);
  const done = fakeItem('done.txt');
  before.track(done);
  done.finish();
  before.shutdown();
  // After shutdown Chromium interrupts what is left; that is not saved.
  running.fail();

  const created = [];
  const after = new DownloadManager({ storePath, createInterrupted: (details) => created.push(details) });
  assert.equal(after.load(), 2);
  assert.deepEqual(after.list().map((entry) => [entry.filename, entry.state, entry.restored]),
    [['done.txt', 'completed', false], ['later.zip', 'paused', true], ['big.iso.part', 'paused', true]]);
  // Only the one that was downloading starts by itself; the one the user paused stays paused.
  assert.equal(after.resumeSaved(), 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].path, partial);
  assert.equal(created[0].offset, 600);
  assert.equal(created[0].length, 1000);
  assert.equal(created[0].eTag, '"v1"');
  assert.equal(fs.statSync(partial).size, 600);
  // Electron hands over the restored item; it is adopted by the same row and resumed.
  const restored = fakeItem('big.iso.part', { savePath: partial });
  restored.interrupted();
  const id = after.track(restored);
  assert.equal(after.list().find((entry) => entry.id === id).filename, 'big.iso.part');
  await tick();
  assert.deepEqual(restored.calls, ['resume']);
  restored.finish();
  assert.equal(stateOf(after, id), 'completed');
});

test('a running download’s partial file outlives Chromium deleting it at shutdown', () => {
  const dir = tempDir();
  const storePath = path.join(dir, 'downloads.json');
  const file = path.join(dir, 'movie.mkv');
  fs.writeFileSync(file, Buffer.alloc(300, 7));
  const before = new DownloadManager({ storePath });
  const item = fakeItem('movie.mkv', { savePath: file });
  before.track(item);
  item.progress(300);
  before.shutdown();
  fs.rmSync(file); // what Chromium does to a download still running when the browser quits
  assert.equal(fs.statSync(`${file}.sbdownload`).size, 300);
  const after = new DownloadManager({ storePath });
  assert.equal(after.load(), 1);
  assert.equal(fs.readFileSync(file).length, 300);
  assert.equal(fs.existsSync(`${file}.sbdownload`), false);
  assert.ok(!('kept' in after.list()[0]));
  // The list can't name another file to recover: the kept copy is always next to its own.
  assert.equal(sanitizeEntry({ filename: 'x', url: 'https://ok.example/x', path: '', kept: true }).kept, false);
});

test('a saved list that was tampered with is cleaned up when loaded', () => {
  assert.equal(sanitizeEntry({ filename: 'x', url: 'file:///C:/Windows/win.ini', path: 'C:\\x' }), null);
  assert.equal(sanitizeEntry({ filename: 'x', url: 'https://ok.example/x', path: 'relative\\x' }), null);
  const clean = sanitizeEntry({ filename: 'x.zip', url: 'https://ok.example/x.zip', path: 'C:\\dl\\x.zip', state: 'exploded', received: -5, urlChain: ['javascript:alert(1)'] });
  assert.equal(clean.state, 'interrupted');
  assert.equal(clean.received, 0);
  assert.deepEqual(clean.urlChain, ['https://ok.example/x.zip']);
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'downloads.json'), '{not json');
  assert.equal(new DownloadManager({ storePath: path.join(dir, 'downloads.json') }).load(), 0);
});

test('finished downloads can be cleared or removed; failed ones stay until removed', () => {
  const manager = new DownloadManager();
  const done = fakeItem('done.txt');
  const failed = fakeItem('failed.txt');
  const running = fakeItem('running.txt');
  manager.track(done);
  const failedId = manager.track(failed);
  const runningId = manager.track(running);
  done.finish();
  failed.fail();
  assert.equal(manager.clearFinished(), 1);
  assert.deepEqual(manager.list().map((entry) => entry.filename), ['running.txt', 'failed.txt']);
  assert.equal(manager.remove(runningId), false);
  assert.equal(manager.remove(failedId), true);
  assert.deepEqual(failed.calls, ['cancel']);
  assert.deepEqual(manager.list().map((entry) => entry.filename), ['running.txt']);
});

test('the toolbar gets names and progress, never addresses or folders', () => {
  const manager = new DownloadManager();
  assert.equal(manager.brief().visible, false);
  const a = fakeItem('a.bin', { total: 1000 });
  const b = fakeItem('b.bin', { total: 3000 });
  manager.track(a);
  manager.track(b);
  a.progress(500);
  b.progress(1500);
  const brief = manager.brief();
  assert.equal(brief.visible, true);
  assert.equal(brief.percent, 50);
  assert.equal(brief.speed, 1000);
  assert.deepEqual(Object.keys(brief.items[0]).sort(), ['filename', 'id', 'kind', 'missing', 'received', 'speed', 'state', 'total']);
});

test('open when done is remembered, and a saved video is marked as one', () => {
  const manager = new DownloadManager();
  manager.expect('https://media.example/clip.mp4', { kind: 'video' });
  const id = manager.track(fakeItem('clip.mp4', { url: 'https://media.example/clip.mp4' }));
  assert.equal(manager.entry(id).kind, 'video');
  assert.equal(manager.setOpenWhenDone(id, true), true);
  assert.equal(manager.entry(id).openWhenDone, true);
  // Pages can't ask for anything but http(s).
  manager.expect('file:///C:/secret.txt', { kind: 'video' });
  assert.equal(manager.expected.size, 0);
});

test('the download policy keeps a resumed file and checks a preset path', () => {
  const resumed = fakeItem('notes.txt', { savePath: 'C:\\dl\\notes.txt' });
  let dialog = null;
  resumed.setSaveDialogOptions = (options) => { dialog = options; };
  assert.equal(guardDownload(resumed, { defaultDir: 'C:\\dl', autoSaveDir: 'C:\\tests' }), true);
  assert.equal(resumed.getSavePath(), 'C:\\dl\\notes.txt');
  assert.equal(dialog, null);

  const blocked = [];
  const sneaky = fakeItem('notes.txt', { savePath: '' });
  assert.equal(guardDownload(sneaky, { defaultDir: 'C:\\dl', presetPath: () => 'C:\\dl\\notes.exe', onBlocked: (name) => blocked.push(name) }), false);
  assert.deepEqual(blocked, ['notes.exe']);
  assert.deepEqual(sneaky.calls, ['cancel']);
});

test('videos on a page: plain files can be saved, streamed and protected ones are explained', () => {
  const videos = classifyVideos([
    { src: 'https://cdn.example/lectures/week%204.mp4?sig=1', width: 1280, height: 720, duration: 3120.4, protected: false, title: 'Lecture' },
    { src: 'https://cdn.example/lectures/week%204.mp4?sig=1', width: 1280, height: 720 }, // the same file twice
    { src: 'blob:https://stream.example/1234', width: 640, height: 360 },
    { src: 'https://drm.example/film.mp4', protected: true },
    { src: 'javascript:alert(1)' },
    { src: 'data:video/mp4;base64,AAAA' },
    'nonsense',
    null,
  ]);
  assert.deepEqual(videos.map((video) => video.kind), ['file', 'streamed', 'protected']);
  assert.equal(videos[0].name, 'week 4.mp4');
  assert.equal(videos[0].duration, 3120);
  assert.equal(videos[1].url, '');
  assert.equal(videos[2].url, '');
  assert.equal(nameFromUrl('https://cdn.example/'), 'video');
  assert.deepEqual(classifyVideos('not a list'), []);
});

test('the right-click menu offers to save plain videos and sounds, never streamed ones', () => {
  const log = [];
  const actions = { saveMedia: (url, kind) => log.push([kind, url]), copyText() {}, openInNewTab() {} };
  const video = buildContextMenuTemplate({ mediaType: 'video', srcURL: 'https://cdn.example/a.mp4' }, actions);
  assert.deepEqual(video.map((item) => item.label), ['Save video as…', 'Copy video address', 'Open video in new tab']);
  video[0].click();
  assert.deepEqual(log, [['video', 'https://cdn.example/a.mp4']]);
  const audio = buildContextMenuTemplate({ mediaType: 'audio', srcURL: 'https://cdn.example/a.mp3' }, actions);
  assert.equal(audio[0].label, 'Save audio as…');
  assert.deepEqual(buildContextMenuTemplate({ mediaType: 'video', srcURL: 'blob:https://stream.example/1' }, actions), []);
});
