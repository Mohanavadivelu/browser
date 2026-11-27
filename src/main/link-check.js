'use strict';

const path = require('node:path');
const { isAllowedUrl } = require('./security/navigation');
const { isDangerousFile } = require('./security/downloads');

// Checks links pasted into the Add links dialog before they are added: each is asked for its
// first byte (a Range request), which tells the file's size, whether the server can resume it,
// and its name. Nothing is downloaded yet.
const MAX_LINKS = 50;
const CHECK_TIMEOUT_MS = 10 * 1000;
const AT_ONCE = 6;

// The links in pasted text, one per line (or separated by spaces), each once, in order.
function parseLinks(text) {
  const seen = new Set();
  const links = [];
  for (const word of String(text ?? '').split(/\s+/)) {
    if (!word || seen.has(word)) continue;
    seen.add(word);
    links.push(word);
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

// The file name a server gives (Content-Disposition), else the last part of the address.
function filenameFrom(url, disposition) {
  const header = disposition ?? '';
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  let name = '';
  try {
    if (encoded) name = decodeURIComponent(encoded[1].trim());
  } catch {
    name = '';
  }
  if (!name && plain) name = (plain[1] ?? plain[2] ?? '').trim();
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      name = '';
    }
  }
  return path.win32.basename(name.replace(/\\/g, '/')).slice(0, 200) || 'download';
}

async function checkLink(fetch, url) {
  if (!isAllowedUrl(url)) {
    return { url, ok: false, reason: /^ftps?:/i.test(url) ? 'FTP links aren’t supported' : 'Not a web address (http or https)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: controller.signal });
    if (response.status >= 400) return { url, ok: false, reason: `The server answered ${response.status}` };
    const name = filenameFrom(response.url || url, response.headers.get('content-disposition'));
    const range = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const resumable = response.status === 206 && Boolean(range);
    const size = resumable ? Number(range[1]) : Number(response.headers.get('content-length')) || 0;
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('text/html') && !response.headers.get('content-disposition')) {
      return { url, ok: false, name, reason: 'This is a web page, not a file' };
    }
    if (isDangerousFile(name)) return { url, ok: false, name, reason: 'This file type is blocked' };
    return { url, ok: true, name, size, resumable };
  } catch (error) {
    return { url, ok: false, reason: error.name === 'AbortError' ? 'No answer in 10 seconds' : 'Could not reach the server' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Checks every link, a few at a time, in their order.
async function checkLinks(fetch, text) {
  const links = parseLinks(text);
  const results = new Array(links.length);
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next;
      next += 1;
      results[index] = await checkLink(fetch, links[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, links.length) }, worker));
  return results;
}

module.exports = { parseLinks, filenameFrom, checkLink, checkLinks, MAX_LINKS };
