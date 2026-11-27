'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SegmentedDownload, RateLimiter, probeRanges, PART_SUFFIX } = require('../../src/main/segmented-download');
const { DownloadManager, sanitizeEntry } = require('../../src/main/download-manager');
const { setInternetMark, INTERNET_ZONE } = require('../../src/main/security/downloads');

const MB = 1024 * 1024;
const content = (size) => {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 13 + 5) % 253;
  return data;
};

// A server for one file that answers Range requests. `options.slowFrom` makes bytes from that
// offset on slow; `options.changed` answers If-Range with the whole (new) file; `options.noRanges`
// ignores Range; `options.gzip` claims a compressed reply.
function fileServer(size, options = {}) {
  const body = content(size);
  const requests = [];
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    requests.push(req.headers.range ?? '');
    res.setHeader('etag', '"v1"');
    res.setHeader('accept-ranges', 'bytes');
    if (options.gzip) res.setHeader('content-encoding', 'gzip');
    let from = 0;
    let to = size - 1;
    if (range && !options.noRanges && !(options.changed && req.headers['if-range'])) {
      from = Number(range[1]);
      to = Math.min(size - 1, Number(range[2]));
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${from}-${to}/${size}`);
    }
    res.setHeader('content-length', String(to - from + 1));
    let pos = from;
    const step = () => {
      if (res.destroyed) return;
      if (pos > to) { res.end(); return; }
      const next = Math.min(to + 1, pos + 16 * 1024);
      res.write(body.subarray(pos, next));
      pos = next;
      setTimeout(step, options.slowFrom !== undefined && pos >= options.slowFrom ? 25 : 0);
    };
    step();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/file.bin`, requests, body, close: () => server.close(),
  })));
}

// Node's fetch has no cache modes; the browser's session fetch does.
const nodeFetch = (url, { cache: _cache, ...init } = {}) => fetch(url, init);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-seg-test-'));
const finished = (download) => new Promise((resolve) => download.once('done', (_event, state) => resolve(state)));

test('a file is fetched in parts at once and put together correctly', async () => {
  const server = await fileServer(6 * MB);
  const savePath = path.join(tempDir(), 'file.bin');
  const download = new SegmentedDownload({ fetch: nodeFetch, url: server.url, filename: 'file.bin', savePath, total: 6 * MB, etag: '"v1"', connections: 4 });
  assert.equal(download.getParts().length, 4);
  const done = finished(download);
  download.start();
  assert.equal(await done, 'completed');
  assert.ok(fs.readFileSync(savePath).equals(server.body));
  assert.equal(fs.existsSync(`${savePath}${PART_SUFFIX}`), false);
  assert.equal(download.getReceivedBytes(), 6 * MB);
  assert.ok(server.requests.filter((range) => range).length >= 4);
  server.close();
});

test('a connection that finishes early takes over half of the slowest part', async () => {
  const server = await fileServer(8 * MB, { slowFrom: 4 * MB });
  const savePath = path.join(tempDir(), 'file.bin');
  const download = new SegmentedDownload({ fetch: nodeFetch, url: server.url, filename: 'file.bin', savePath, total: 8 * MB, connections: 2 });
  const done = finished(download);
  download.start();
  assert.equal(await done, 'completed');
  assert.ok(download.getParts().length > 2, `${download.getParts().length} parts`);
  assert.ok(fs.readFileSync(savePath).equals(server.body));
  server.close();
});

test('pause stops every connection; resume asks only for what is missing', async () => {
  const server = await fileServer(4 * MB, { slowFrom: 0 });
  const savePath = path.join(tempDir(), 'file.bin');
  const download = new SegmentedDownload({ fetch: nodeFetch, url: server.url, filename: 'file.bin', savePath, total: 4 * MB, etag: '"v1"', connections: 2 });
  download.start();
  await new Promise((resolve) => setTimeout(resolve, 400));
  download.pause();
  assert.equal(download.isPaused(), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pausedAt = download.getReceivedBytes();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(download.getReceivedBytes(), pausedAt);
  assert.ok(pausedAt > 0 && pausedAt < 4 * MB);
  const before = server.requests.length;
  const done = finished(download);
  download.resume();
  assert.equal(await done, 'completed');
  const resumed = server.requests.slice(before);
  assert.ok(resumed.every((range) => !range.startsWith('bytes=0-')), resumed.join(' '));
  assert.ok(fs.readFileSync(savePath).equals(server.body));
  server.close();
});

test('a file that changed on the server cannot be resumed, and its parts are thrown away', async () => {
  const server = await fileServer(4 * MB, { changed: true });
  const savePath = path.join(tempDir(), 'file.bin');
  const download = new SegmentedDownload({ fetch: nodeFetch, url: server.url, filename: 'file.bin', savePath, total: 4 * MB, etag: '"v1"', connections: 2 });
  const done = finished(download);
  download.start();
  assert.equal(await done, 'interrupted');
  assert.equal(download.canResume(), false);
  assert.equal(fs.existsSync(`${savePath}${PART_SUFFIX}`), false);
  server.close();
});

test('saved parts go on from where they were, in the file kept next to the download', async () => {
  const size = 4 * MB;
  const server = await fileServer(size);
  const savePath = path.join(tempDir(), 'file.bin');
  // Half of each part already in the file.
  const partial = Buffer.alloc(size);
  server.body.copy(partial, 0, 0, MB);
  server.body.copy(partial, 2 * MB, 2 * MB, 3 * MB);
  fs.writeFileSync(`${savePath}${PART_SUFFIX}`, partial);
  const download = new SegmentedDownload({ fetch: nodeFetch, url: server.url, filename: 'file.bin', savePath, total: size, etag: '"v1"', connections: 2,
    parts: [[0, 2 * MB - 1, MB], [2 * MB, size - 1, 3 * MB]] });
  assert.equal(download.getReceivedBytes(), 2 * MB);
  const done = finished(download);
  download.resume();
  assert.equal(await done, 'completed');
  assert.deepEqual(server.requests.sort(), [`bytes=${MB}-${2 * MB - 1}`, `bytes=${3 * MB}-${size - 1}`].sort());
  assert.ok(fs.readFileSync(savePath).equals(server.body));
  server.close();
});

test('the speed limit holds downloads to their share', async () => {
  const server = await fileServer(MB);
  const savePath = path.join(tempDir(), 'file.bin');
  const limiter = new RateLimiter(() => 2 * MB);
  const download = new SegmentedDownload({ fetch: nodeFetch, url: server.url, filename: 'file.bin', savePath, total: MB, connections: 1, limiter });
  const started = Date.now();
  const done = finished(download);
  download.start();
  assert.equal(await done, 'completed');
  assert.ok(Date.now() - started >= 350, `${Date.now() - started} ms for 1 MB at 2 MB/s`);
  server.close();
});

test('the probe accepts only a byte range of the same file, uncompressed', async () => {
  const good = await fileServer(5 * MB);
  assert.equal(await probeRanges(nodeFetch, { url: good.url, total: 5 * MB, etag: '"v1"' }), true);
  assert.equal(await probeRanges(nodeFetch, { url: good.url, total: 6 * MB, etag: '"v1"' }), false);
  assert.equal(await probeRanges(nodeFetch, { url: good.url, total: 5 * MB, etag: '"v2"' }), false);
  good.close();
  const whole = await fileServer(5 * MB, { noRanges: true });
  assert.equal(await probeRanges(nodeFetch, { url: whole.url, total: 5 * MB }), false);
  whole.close();
  const packed = await fileServer(5 * MB, { gzip: true });
  assert.equal(await probeRanges(nodeFetch, { url: packed.url, total: 5 * MB }), false);
  packed.close();
});

// A stand-in for Electron's DownloadItem.
function chromiumItem(name, total) {
  const item = new EventEmitter();
  let received = 0;
  let paused = false;
  Object.assign(item, {
    calls: [],
    getFilename: () => name,
    getURL: () => `https://files.example/${name}`,
    getURLChain: () => [`https://files.example/${name}`],
    getTotalBytes: () => total,
    getReceivedBytes: () => received,
    getSavePath: () => `C:\\dl\\${name}`,
    getETag: () => '"v1"',
    isPaused: () => paused,
    canResume: () => true,
    pause: () => { item.calls.push('pause'); paused = true; item.emit('updated', {}, 'progressing'); },
    resume: () => { item.calls.push('resume'); paused = false; item.emit('updated', {}, 'progressing'); },
    cancel: () => { item.calls.push('cancel'); item.emit('done', {}, 'cancelled'); },
    progress: (bytes) => { received = bytes; item.emit('updated', {}, 'progressing'); },
  });
  return item;
}

function fakeSplit(details) {
  const split = chromiumItem(details.filename, details.total);
  Object.assign(split, { isSegmented: true, details, start: () => split.calls.push('start'), getParts: () => [[0, details.total - 1, 0]], getActiveConnections: () => 4 });
  return split;
}

test('a big download whose server allows parts is handed over to several connections', async () => {
  const created = [];
  const manager = new DownloadManager({
    segmented: { connections: () => 4, probe: async () => true, create: (details) => { const split = fakeSplit(details); created.push(split); return split; } },
  });
  const item = chromiumItem('big.iso.zip', 50 * MB);
  const id = manager.track(item, { session: 'the-session' });
  item.progress(1000);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);
  assert.equal(created[0].details.session, 'the-session');
  assert.equal(created[0].details.connections, 4);
  assert.deepEqual(item.calls, ['cancel']);
  assert.deepEqual(created[0].calls, ['start']);
  // Chromium's cancelled download doesn't touch the row; the split one carries on in it.
  const entry = manager.list().find((row) => row.id === id);
  assert.equal(entry.state, 'progressing');
  assert.equal(entry.connections, 4);
  assert.equal(manager.list().length, 1);
});

test('small downloads, a refused probe, or one connection leave the download with Chromium', async () => {
  let probes = 0;
  const segmented = (connections, answer) => ({ connections: () => connections, probe: async () => { probes += 1; return answer; }, create: fakeSplit });
  for (const [manager, item] of [
    [new DownloadManager({ segmented: segmented(4, true) }), chromiumItem('small.zip', MB)],
    [new DownloadManager({ segmented: segmented(1, true) }), chromiumItem('one.zip', 50 * MB)],
    [new DownloadManager({ segmented: segmented(4, false) }), chromiumItem('refused.zip', 50 * MB)],
  ]) {
    manager.track(item);
    item.progress(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(item.calls, [], item.getFilename());
  }
  assert.equal(probes, 1);
});

test('with a speed limit on, even a small one-connection download is handed to the browser’s reader', async () => {
  const created = [];
  const manager = new DownloadManager({
    speedLimit: () => 1024 * 1024,
    segmented: { connections: () => 1, probe: async () => true, create: (details) => { const own = fakeSplit(details); created.push(own); return own; } },
  });
  const item = chromiumItem('small.pdf', 300 * 1024);
  manager.track(item);
  item.progress(10);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);
  assert.equal(created[0].details.connections, 1);
  assert.deepEqual(item.calls, ['cancel']);
  clearInterval(manager.throttleTimer);
});

test('the speed limit pauses Chromium\u2019s own downloads while over it, without calling them paused', () => {
  const manager = new DownloadManager({ speedLimit: () => 100 * 1024 });
  const item = chromiumItem('plain.bin', MB);
  const id = manager.track(item);
  item.progress(10);
  item.progress(400 * 1024);
  manager.throttleTick(); // starts counting
  item.progress(800 * 1024);
  manager.throttleTick();
  assert.deepEqual(item.calls, ['pause']);
  assert.equal(manager.list().find((row) => row.id === id).state, 'progressing');
  manager.limiter.tokens = 10;
  manager.throttleTick();
  assert.deepEqual(item.calls, ['pause', 'resume']);
  // A pause by the user is not undone by the limit.
  manager.pause(id);
  manager.limiter.tokens = 10;
  manager.throttleTick();
  assert.equal(manager.list().find((row) => row.id === id).state, 'paused');
  clearInterval(manager.throttleTimer);
});

test('saved parts are checked when the list is loaded', () => {
  const base = { filename: 'f.bin', url: 'https://ok.example/f.bin', path: 'C:\\dl\\f.bin', total: 100 };
  assert.deepEqual(sanitizeEntry({ ...base, parts: [[0, 49, 10], [50, 99, 99]] }).parts, [[0, 49, 10], [50, 99, 99]]);
  for (const parts of [[[0, 100, 0]], [[10, 5, 10]], [[0, 49, 60]], [[0, 49, -1]], [[0, 49]], 'x', []]) {
    assert.equal(sanitizeEntry({ ...base, parts }).parts, null, JSON.stringify(parts));
  }
});

test('downloads are marked as coming from the internet, or not, on Windows', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(tempDir(), 'file.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(setInternetMark(file, true), true);
  assert.equal(fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'), INTERNET_ZONE);
  assert.equal(setInternetMark(file, false), true);
  assert.throws(() => fs.readFileSync(`${file}:Zone.Identifier`));
  assert.equal(setInternetMark(file, true, 'linux'), false);
});
