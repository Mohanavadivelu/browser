'use strict';

const { isAllowedUrl } = require('./security/navigation');

// The new tab page's tiles: the most visited pages (from history, only while it is on, and never
// in private tabs) and the first bookmarks of the bookmarks bar. They travel in the new tab page's
// address (it is web content, with no bridge to the browser), so each is kept short. A tile the
// user removes is hidden from then on (settings.newTabHidden).
const MAX_TOP = 8;
const MAX_BOOKMARKS = 8;
const MAX_TITLE = 60;
const MAX_URL = 400;
const MAX_HIDDEN = 200;

const withoutFragment = (url) => url.split('#')[0];

function tile(url, title) {
  return { url, title: String(title || '').slice(0, MAX_TITLE) };
}

// The pages visited most often (each visit is an entry), newest first among equals.
function topSites(entries, hidden, limit = MAX_TOP) {
  const pages = new Map();
  for (const entry of entries) {
    const url = withoutFragment(entry.url);
    if (!isAllowedUrl(url) || url.length > MAX_URL || hidden.has(url)) continue;
    const page = pages.get(url) ?? { url, title: '', visits: 0, last: 0 };
    page.visits += 1;
    if (entry.time >= page.last) {
      page.last = entry.time;
      page.title = entry.title || page.title;
    }
    pages.set(url, page);
  }
  return [...pages.values()]
    .sort((a, b) => b.visits - a.visits || b.last - a.last)
    .slice(0, limit)
    .map((page) => tile(page.url, page.title));
}

function newTabTiles({ entries, historyOn, isPrivate, barLinks, hidden }) {
  const hiddenSet = new Set(hidden);
  const top = historyOn && !isPrivate ? topSites(entries, hiddenSet) : [];
  const shown = new Set(top.map((page) => page.url));
  const bookmarks = barLinks
    .filter((link) => isAllowedUrl(link.url) && link.url.length <= MAX_URL && !shown.has(link.url))
    .slice(0, MAX_BOOKMARKS)
    .map((link) => tile(link.url, link.title));
  return { top, bookmarks };
}

// A removed tile, from the new tab page's #hide=<address>; null for anything else.
function hiddenFromHash(hash) {
  const match = /^#hide=(.+)$/.exec(hash ?? '');
  if (!match) return null;
  try {
    const url = decodeURIComponent(match[1]);
    return isAllowedUrl(url) && url.length <= MAX_URL ? url : null;
  } catch {
    return null;
  }
}

function addHidden(hidden, url) {
  return [...new Set([...hidden, url])].slice(-MAX_HIDDEN);
}

module.exports = { topSites, newTabTiles, hiddenFromHash, addHidden, MAX_HIDDEN };
