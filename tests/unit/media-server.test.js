'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRange, serveMedia, mediaUrl } = require('../../src/main/recording/media-server');

test('byte ranges are read as the player sends them', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=20-10', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
});

function folderWith(files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-media-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content);
  return folder;
}

test('a recording is served whole, or in the range asked for', async () => {
  const bytes = Buffer.from(Array.from({ length: 200 }, (_, i) => i));
  const folder = folderWith({ 'recording-1.webm': bytes, 'shot 1.png': 'png' });

  const whole = serveMedia(folder, mediaUrl('recording-1.webm'));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/webm');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));

  const part = serveMedia(folder, mediaUrl('recording-1.webm'), 'bytes=100-149');
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-149/200');
  assert.equal(part.headers.get('content-length'), '50');
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 150)));

  const beyond = serveMedia(folder, mediaUrl('recording-1.webm'), 'bytes=500-');
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), 'bytes */200');

  const image = serveMedia(folder, mediaUrl('shot 1.png'));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('only plain recording and screenshot names inside the folder are served', () => {
  const folder = folderWith({ 'recording-1.webm': 'x', 'notes.txt': 'secret' });
  const outside = path.join(path.dirname(folder), 'outside.webm');
  fs.writeFileSync(outside, 'outside');
  for (const url of [
    mediaUrl('notes.txt'),
    mediaUrl('../outside.webm'),
    mediaUrl('..\\outside.webm'),
    mediaUrl(outside),
    mediaUrl('missing.webm'),
    'sb-media://elsewhere/recording-1.webm',
    'sb-media://recordings/%E0%A4%A',
  ]) {
    assert.equal(serveMedia(folder, url).status, 404, url);
  }
});
