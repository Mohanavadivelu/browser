'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DownloadManager, parseChecksum, uniquePath } = require('../../src/main/download-manager');
const { WhenDone } = require('../../src/main/when-done');
const { parseLinks, filenameFrom, checkLink, checkLinks } = require('../../src/main/link-check');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-queue-test-'));
const links = (...names) => names.map((name) => ({ url: `https://files.example/${name}`, filename: name, total: 100 }));

// Chromium starting a download that was asked for: the item it hands to track().
function startedItem(manager, url, name) {
  const item = new EventEmitter();
  let savePath = '';
  Object.assign(item, {
    getFilename: () => name,
    getURL: () => url,
    getURLChain: () => [url],
    getTotalBytes: () => 100,
    getReceivedBytes: () => 0,
    getSavePath: () => savePath,
    setSavePath: (value) => { savePath = value; },
    isPaused: () => false,
    canResume: () => true,
    pause() {}, resume() {}, cancel() {},
  });
  item.setSavePath(manager.presetPath(item));
  manager.track(item);
  return item;
}

test('added links wait their turn and start in their order, into the chosen folder', () => {
  const started = [];
  const dir = tempDir();
  const manager = new DownloadManager({ maxActive: () => 2, startDownload: (url) => started.push(url) });
  const ids = manager.addLinks({ links: links('a.zip', 'b.zip', 'c.zip'), saveDir: dir, start: 'queue' });
  assert.equal(ids.length, 3);
  assert.deepEqual(started, ['https://files.example/a.zip', 'https://files.example/b.zip']);
  assert.deepEqual(manager.list().map((entry) => [entry.filename, entry.state]).reverse(),
    [['a.zip', 'progressing'], ['b.zip', 'progressing'], ['c.zip', 'queued']]);
  // Chromium hands over the first one: it goes into the folder, under the server's name.
  fs.writeFileSync(path.join(dir, 'a-from-server.zip'), 'already here');
  const item = startedItem(manager, 'https://files.example/a.zip', 'a-from-server.zip');
  assert.equal(item.getSavePath(), path.join(dir, 'a-from-server (2).zip'));
  const first = manager.list().find((entry) => entry.id === ids[0]);
  assert.equal(first.filename, 'a-from-server.zip');
  assert.equal(manager.list().length, 3);
  item.emit('done', {}, 'completed');
  assert.deepEqual(started.at(-1), 'https://files.example/c.zip');
});

test('the queue can be reordered, and starts in the new order', () => {
  const started = [];
  const manager = new DownloadManager({ maxActive: () => 0, startDownload: (url) => started.push(url) });
  const [a, b, c] = manager.addLinks({ links: links('a', 'b', 'c'), saveDir: tempDir(), start: 'queue' });
  assert.equal(manager.move(c, a), true);
  assert.equal(manager.move(a, null), true);
  assert.deepEqual(manager.queue().map(({ entry }) => entry.id), [c, b, a]);
  assert.equal(manager.move(b, 999), false);
  manager.maxActive = () => 1;
  manager.pump();
  assert.deepEqual(started, ['https://files.example/c']);
});

test('a start time, and the night setting, hold added links back until then', () => {
  let now = new Date(2026, 10, 27, 14, 0).getTime();
  let night = null;
  const started = [];
  const manager = new DownloadManager({ now: () => now, nightWindow: () => night, startDownload: (url) => started.push(url) });
  const at = new Date(2026, 10, 27, 23, 30).getTime();
  manager.addLinks({ links: links('later.iso.zip'), saveDir: tempDir(), start: 'at', startAt: at });
  assert.deepEqual(started, []);
  now = at + 1000;
  manager.pump();
  assert.deepEqual(started, ['https://files.example/later.iso.zip']);

  // Night is 23:00 to 06:00 (it runs past midnight).
  night = { from: 23 * 60, to: 6 * 60 };
  now = new Date(2026, 10, 28, 12, 0).getTime();
  manager.addLinks({ links: links('nightly.zip'), saveDir: tempDir(), start: 'queue' });
  assert.equal(started.length, 1);
  now = new Date(2026, 10, 29, 2, 0).getTime();
  manager.pump();
  assert.deepEqual(started.at(-1), 'https://files.example/nightly.zip');
  assert.equal(manager.inNightWindow(new Date(2026, 10, 29, 6, 0).getTime()), false);
  assert.equal(manager.inNightWindow(new Date(2026, 10, 29, 23, 0).getTime()), true);

  // Start now ignores both; so does Start now on a waiting row.
  now = new Date(2026, 10, 29, 12, 0).getTime();
  manager.addLinks({ links: links('now.zip'), saveDir: tempDir(), start: 'now' });
  assert.deepEqual(started.at(-1), 'https://files.example/now.zip');
  const [waiting] = manager.addLinks({ links: links('asked.zip'), saveDir: tempDir(), start: 'queue' });
  assert.equal(manager.resume(waiting), true);
  assert.deepEqual(started.at(-1), 'https://files.example/asked.zip');
  clearInterval(manager.scheduleTimer);
});

test('added links that had not started still wait after a restart', () => {
  const dir = tempDir();
  const storePath = path.join(dir, 'downloads.json');
  const before = new DownloadManager({ storePath, maxActive: () => 0, startDownload: () => {} });
  before.addLinks({ links: links('one.zip', 'two.zip'), saveDir: dir, start: 'at', startAt: Date.now() + 3_600_000 });
  before.shutdown();
  const started = [];
  const after = new DownloadManager({ storePath, startDownload: (url) => started.push(url) });
  assert.equal(after.load(), 0);
  assert.equal(after.resumeSaved(), 0);
  after.pump();
  assert.deepEqual(after.list().map((entry) => [entry.state, entry.deferred, entry.saveDir === dir]), [['queued', true, true], ['queued', true, true]]);
  assert.deepEqual(started, []);
  assert.ok(after.scheduleTimer);
  clearInterval(after.scheduleTimer);
});

test('a download asked for that never begins is shown as failed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const manager = new DownloadManager({ startDownload: () => {} });
  const [id] = manager.addLinks({ links: links('nothing.zip'), saveDir: tempDir(), start: 'now' });
  assert.equal(manager.entry(id).state, 'progressing');
  t.mock.timers.tick(31_000);
  assert.equal(manager.entry(id).state, 'interrupted');
});

test('checksums: only a SHA-256 is taken, and the finished file is checked against it', async () => {
  assert.equal(parseChecksum(` ${'AB'.repeat(32)} `), 'ab'.repeat(32));
  assert.equal(parseChecksum('abc'), '');
  assert.equal(parseChecksum('g'.repeat(64)), '');
  const dir = tempDir();
  const file = path.join(dir, 'data.bin');
  fs.writeFileSync(file, 'the file');
  const good = crypto.createHash('sha256').update('the file').digest('hex');
  const manager = new DownloadManager();
  const item = new EventEmitter();
  Object.assign(item, {
    getFilename: () => 'data.bin', getURL: () => 'https://files.example/data.bin', getTotalBytes: () => 8, getReceivedBytes: () => 8,
    getSavePath: () => file, isPaused: () => false, pause() {}, resume() {}, cancel() {},
  });
  const id = manager.track(item);
  assert.equal(manager.setChecksum(id, 'not one'), false);
  assert.equal(manager.setChecksum(id, good.toUpperCase()), true);
  const checked = new Promise((resolve) => manager.once('checksum', resolve));
  item.emit('done', {}, 'completed');
  assert.equal((await checked).checksum.result, 'match');
  const again = new Promise((resolve) => manager.once('checksum', resolve));
  manager.setChecksum(id, '0'.repeat(64));
  assert.equal((await again).checksum.result, 'mismatch');
});

test('a free name is found in the folder, and unsafe characters are replaced', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'report.pdf'), '');
  assert.equal(uniquePath(dir, 'report.pdf', new Set()), path.join(dir, 'report (2).pdf'));
  assert.equal(uniquePath(dir, 'new.pdf', new Set([path.join(dir, 'new.pdf').toLowerCase()])), path.join(dir, 'new (2).pdf'));
  assert.equal(path.basename(uniquePath(dir, 'a<b>:c?.txt', new Set())), 'a_b__c_.txt');
  assert.equal(path.basename(uniquePath(dir, '..\\..\\evil.txt', new Set())), 'evil.txt');
});

// Downloads stand-in for WhenDone: idle or not, and a change event.
function fakeDownloads() {
  const downloads = new EventEmitter();
  downloads.idle = true;
  downloads.set = (idle) => { downloads.idle = idle; downloads.emit('change'); };
  return downloads;
}

test('when all downloads finish, the computer sleeps or shuts down after a countdown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const downloads = fakeDownloads();
  const runs = [];
  const notices = [];
  const whenDone = new WhenDone({ downloads, run: (action) => runs.push(action), notify: (text) => notices.push(text), countdownMs: 60_000 });
  whenDone.set('shutdown');
  // Nothing was downloading: it waits for something to download first.
  downloads.set(true);
  assert.equal(whenDone.state().endsAt, 0);
  downloads.set(false);
  downloads.set(true);
  assert.ok(whenDone.state().endsAt > 0);
  assert.match(notices.at(-1), /shut down in 60 seconds/);
  // Something starts again: the countdown stops, and begins again when it finishes.
  downloads.set(false);
  assert.equal(whenDone.state().endsAt, 0);
  downloads.set(true);
  t.mock.timers.tick(60_000);
  assert.deepEqual(runs, ['shutdown']);
  assert.equal(whenDone.state().action, 'none');
});

test('the countdown can be cancelled, and nothing else is accepted', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const downloads = fakeDownloads();
  const runs = [];
  const whenDone = new WhenDone({ downloads, run: (action) => runs.push(action), countdownMs: 1000 });
  assert.equal(whenDone.set('format-disk').action, 'none');
  downloads.set(false);
  whenDone.set('sleep');
  downloads.set(true);
  assert.equal(whenDone.cancel().action, 'none');
  t.mock.timers.tick(5000);
  assert.deepEqual(runs, []);
});

test('pasted links are split, each once, and named from the server or the address', () => {
  assert.deepEqual(parseLinks('https://a.example/1.zip\n  https://a.example/2.zip https://a.example/1.zip\n\n'), ['https://a.example/1.zip', 'https://a.example/2.zip']);
  assert.equal(parseLinks(Array.from({ length: 80 }, (_, i) => `https://a.example/${i}`).join('\n')).length, 50);
  assert.equal(filenameFrom('https://a.example/dir/file%20one.zip?x=1', null), 'file one.zip');
  assert.equal(filenameFrom('https://a.example/x', 'attachment; filename="report.pdf"'), 'report.pdf');
  assert.equal(filenameFrom('https://a.example/x', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(filenameFrom('https://a.example/x', 'attachment; filename="..\\\\..\\\\evil.txt"'), 'evil.txt');
  assert.equal(filenameFrom('https://a.example/', null), 'download');
});

test('links are checked for size, resuming and what they are, before anything downloads', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/file.zip') {
      res.statusCode = req.headers.range ? 206 : 200;
      res.setHeader('content-range', 'bytes 0-0/5000');
      res.setHeader('content-length', '1');
      res.end('x');
    } else if (req.url === '/plain.bin') {
      res.setHeader('content-length', '1234');
      res.end(Buffer.alloc(1234));
    } else if (req.url === '/page') {
      res.setHeader('content-type', 'text/html');
      res.end('<p>hi</p>');
    } else if (req.url === '/setup') {
      res.setHeader('content-disposition', 'attachment; filename="setup.exe"');
      res.end('MZ');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const nodeFetch = (url, { cache: _cache, ...init } = {}) => fetch(url, init);
  assert.deepEqual(await checkLink(nodeFetch, `${base}/file.zip`), { url: `${base}/file.zip`, ok: true, name: 'file.zip', size: 5000, resumable: true });
  assert.deepEqual(await checkLink(nodeFetch, `${base}/plain.bin`), { url: `${base}/plain.bin`, ok: true, name: 'plain.bin', size: 1234, resumable: false });
  const results = await checkLinks(nodeFetch, `${base}/page\n${base}/setup\n${base}/missing\nftp://old.example/readme.txt\njavascript:alert(1)`);
  assert.deepEqual(results.map((result) => [result.ok, result.reason]), [
    [false, 'This is a web page, not a file'],
    [false, 'This file type is blocked'],
    [false, 'The server answered 404'],
    [false, 'FTP links aren’t supported'],
    [false, 'Not a web address (http or https)'],
  ]);
  server.close();
});
