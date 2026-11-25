'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { isSafeName } = require('./library');

// The browser's own pages show recordings and screenshots through this private scheme, e.g.
// sb-media://recordings/recording-20261125-101500.webm. It is served only in the session of the
// browser's own pages (web pages cannot use it) and only for plain recording and screenshot
// file names inside the recordings folder. Byte ranges are supported, so the player can seek.
const MEDIA_SCHEME = 'sb-media';
const CONTENT_TYPES = Object.freeze({ '.webm': 'video/webm', '.png': 'image/png' });

function mediaUrl(name) {
  return `${MEDIA_SCHEME}://recordings/${encodeURIComponent(name)}`;
}

// For registerSchemesAsPrivileged (before the app is ready): lets the player stream and seek in
// these files.
const MEDIA_SCHEME_PRIVILEGES = Object.freeze({
  scheme: MEDIA_SCHEME,
  privileges: { stream: true, secure: true, supportFetchAPI: true },
});

// A "Range: bytes=…" header for a file of `size` bytes: { start, end } (inclusive), null when
// there is no usable range (send the whole file), or 'invalid' when it cannot be satisfied.
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// The answer for one request, from the file name in the URL.
function serveMedia(folder, url, rangeHeader) {
  let name;
  try {
    const parsed = new URL(url);
    if (parsed.host !== 'recordings') return new Response('Not found', { status: 404 });
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!isSafeName(folder, name)) return new Response('Not found', { status: 404 });
  const filePath = path.join(folder, name);
  let size;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return new Response('Not found', { status: 404 });
    size = stats.size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(name).toLowerCase()],
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  if (size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...headers, 'Content-Length': '0' } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(body, { status: range ? 206 : 200, headers });
}

// Serves the scheme in one session (the browser's own pages).
function serveRecordings(session, getFolder) {
  // A second start in the same process (tests do this) replaces the handler.
  if (session.protocol.isProtocolHandled(MEDIA_SCHEME)) session.protocol.unhandle(MEDIA_SCHEME);
  session.protocol.handle(MEDIA_SCHEME, (request) => serveMedia(getFolder(), request.url, request.headers.get('range')));
}

module.exports = { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, mediaUrl, parseRange, serveMedia, serveRecordings };
