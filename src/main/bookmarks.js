'use strict';

const { isAllowedUrl } = require('./security/navigation');

const MAX_TITLE_LENGTH = 200;

// Bookmarks are a list of { url, title }, one per address. These helpers return a new list
// (or null when the bookmark is not there) and never change the one they are given.

function cleanTitle(title, url) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return text || url;
}

function rename(list, url, title) {
  if (!list.some((bookmark) => bookmark.url === url)) return null;
  return list.map((bookmark) => (bookmark.url === url ? { url, title: cleanTitle(title, url) } : bookmark));
}

function remove(list, url) {
  const next = list.filter((bookmark) => bookmark.url !== url);
  return next.length === list.length ? null : next;
}

function move(list, url, index) {
  const from = list.findIndex((bookmark) => bookmark.url === url);
  if (from === -1) return null;
  const next = [...list];
  const [bookmark] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, bookmark);
  return next;
}

// ---------- The bookmarks HTML file Chrome, Edge and Firefox read and write ----------

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toHtml(list) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    ...list.map((bookmark) => `    <DT><A HREF="${escapeHtml(bookmark.url)}">${escapeHtml(bookmark.title)}</A>`),
    '</DL><p>',
    '',
  ];
  return lines.join('\n');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// Every http(s) link in a bookmarks file, in order. Folders are flattened.
function fromHtml(html) {
  const found = [];
  const link = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html).matchAll(link)) {
    const url = decodeHtml(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!isAllowedUrl(url)) continue;
    const title = decodeHtml(match[4].replace(/<[^>]*>/g, ''));
    found.push({ url, title: cleanTitle(title, url) });
  }
  return found;
}

// Adds imported bookmarks after the existing ones, skipping addresses already there and
// stopping at `max`.
function merge(list, imported, max) {
  const known = new Set(list.map((bookmark) => bookmark.url));
  const next = [...list];
  let skipped = 0;
  for (const bookmark of imported) {
    if (known.has(bookmark.url) || next.length >= max) {
      skipped += 1;
      continue;
    }
    known.add(bookmark.url);
    next.push(bookmark);
  }
  return { list: next, added: next.length - list.length, skipped };
}

module.exports = { rename, remove, move, toHtml, fromHtml, merge, cleanTitle };
