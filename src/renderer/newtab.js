'use strict';

// The new tab page: a search box (for the engine chosen in Settings), the most visited pages and
// the first bookmarks of the bookmarks bar. It is web content with no bridge to the browser:
// everything comes in its address, and the × on a tile sets #hide=<address>, which the browser
// notes so the tile doesn't come back. Nothing is loaded from the internet.
const ENDPOINTS = {
  google: 'https://www.google.com/search',
  duckduckgo: 'https://duckduckgo.com/',
  bing: 'https://www.bing.com/search',
};
const COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#00838f', '#c5221f', '#3c4043'];

const params = new URLSearchParams(location.search);
const engine = params.get('engine');
if (Object.hasOwn(ENDPOINTS, engine)) document.getElementById('search').action = ENDPOINTS[engine];

let tiles = { top: [], bookmarks: [] };
try {
  const parsed = JSON.parse(params.get('tiles') ?? 'null');
  if (parsed && Array.isArray(parsed.top) && Array.isArray(parsed.bookmarks)) tiles = parsed;
} catch {
  // No tiles: the page still works.
}

const webAddress = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

// A letter on a colour from the site's name: no icons are fetched.
function badge(host) {
  const node = document.createElement('span');
  node.className = 'icon';
  const name = host.replace(/^www\./, '');
  node.textContent = (name[0] || '?').toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  node.style.background = COLORS[hash % COLORS.length];
  return node;
}

function tileFor(entry, removable) {
  const address = webAddress(entry.url);
  if (!address) return null;
  const tile = document.createElement('a');
  tile.className = 'tile';
  tile.href = address.href;
  tile.title = `${entry.title || address.host}\n${address.href}`;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = entry.title || address.host;
  tile.append(badge(address.host), label);
  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Don't show ${entry.title || address.host} here`);
    remove.title = 'Don\'t show this here';
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      tile.remove();
      location.hash = `hide=${encodeURIComponent(entry.url)}`;
      showSections();
    });
    tile.append(remove);
  }
  return tile;
}

function fill(id, entries, removable) {
  const nav = document.getElementById(id);
  nav.replaceChildren(...entries.slice(0, 8).map((entry) => tileFor(entry, removable)).filter(Boolean));
}

function showSections() {
  const top = document.getElementById('topTiles').children.length;
  const bookmarks = document.getElementById('bookmarkTiles').children.length;
  document.getElementById('topSection').hidden = top === 0;
  document.getElementById('bookmarkSection').hidden = bookmarks === 0;
  document.getElementById('emptyHint').hidden = top + bookmarks > 0;
}

fill('topTiles', tiles.top, true);
fill('bookmarkTiles', tiles.bookmarks, false);
showSections();
