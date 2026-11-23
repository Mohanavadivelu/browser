'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchFavicon, MAX_ICON_BYTES } = require('../../src/main/favicons');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

// A session whose fetch answers from `reply(url, init)` and remembers what it was asked.
function session(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(url);
      return reply(url, init);
    },
  };
}
const respond = (body, headers = {}, status = 200) => new Response(body, { status, headers });

test('icons come back as data: URLs typed from their bytes', async () => {
  const png = await fetchFavicon(session(() => respond(PNG, { 'content-type': 'application/octet-stream' })), 'https://a.example/favicon.png');
  assert.equal(png, `data:image/png;base64,${PNG.toString('base64')}`);
  const ico = await fetchFavicon(session(() => respond(ICO, { 'content-type': 'text/plain' })), 'http://a.example/favicon.ico');
  assert.match(ico, /^data:image\/x-icon;base64,/);
});

test('SVG icons need the server to say they are SVG', async () => {
  assert.match(await fetchFavicon(session(() => respond(SVG, { 'content-type': 'image/svg+xml; charset=utf-8' })), 'https://a.example/i.svg'), /^data:image\/svg\+xml;base64,/);
  assert.equal(await fetchFavicon(session(() => respond(SVG, { 'content-type': 'text/html' })), 'https://a.example/i.svg'), '');
});

test('anything that is not a small image is dropped', async () => {
  const html = respond('<html>not an icon</html>', { 'content-type': 'image/png' });
  assert.equal(await fetchFavicon(session(() => html), 'https://a.example/i.png'), '');
  assert.equal(await fetchFavicon(session(() => respond(PNG, {}, 404)), 'https://a.example/i.png'), '');
  assert.equal(await fetchFavicon(session(() => respond(new Uint8Array(0))), 'https://a.example/i.png'), '');
  const declaredLarge = respond(PNG, { 'content-length': String(MAX_ICON_BYTES + 1) });
  assert.equal(await fetchFavicon(session(() => declaredLarge), 'https://a.example/i.png'), '');
  const big = Buffer.concat([PNG, Buffer.alloc(2000)]);
  assert.equal(await fetchFavicon(session(() => respond(big)), 'https://a.example/i.png', { maxBytes: 1000 }), '');
  assert.equal(await fetchFavicon(session(() => { throw new Error('offline'); }), 'https://a.example/i.png'), '');
});

test('only http and https icons are fetched', async () => {
  const s = session(() => respond(PNG));
  for (const url of ['file:///C:/secret.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'chrome://favicon/x']) {
    assert.equal(await fetchFavicon(s, url), '');
  }
  assert.deepEqual(s.calls, []);
});

test('a server that never answers is given up on', async () => {
  const hanging = session((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const started = Date.now();
  assert.equal(await fetchFavicon(hanging, 'https://slow.example/i.png', { timeoutMs: 30 }), '');
  assert.ok(Date.now() - started < 2000);
});
