'use strict';

const { resolveInput, engineFor, internalUrl } = require('./security/navigation');

const DEFAULT_LIMIT = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

// "https://www.example.com/a" -> "example.com/a": what people type and look for.
function displayUrl(url) {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// One entry per address, with how often and how recently it was visited.
function visitsByUrl(entries) {
  const visits = new Map();
  for (const entry of entries) {
    const known = visits.get(entry.url);
    if (known) {
      known.count += 1;
      known.last = Math.max(known.last, entry.time);
      if (entry.title) known.title = entry.title;
    } else {
      visits.set(entry.url, { url: entry.url, title: entry.title, count: 1, last: entry.time });
    }
  }
  return [...visits.values()];
}

// How well a page matches what was typed, or 0 if it does not contain every word typed.
function matchScore(page, text, words) {
  const address = displayUrl(page.url).toLowerCase();
  const title = (page.title ?? '').toLowerCase();
  if (!words.every((word) => address.includes(word) || title.includes(word))) return 0;
  let score = 1;
  if (hostOf(page.url).startsWith(words[0])) score += 100;
  if (address.startsWith(text)) score += 60;
  const titleWords = title.split(/[^\p{L}\p{N}]+/u);
  score += 20 * words.filter((word) => titleWords.some((part) => part.startsWith(word))).length;
  return score;
}

// The address the typed text most likely begins, to fill in after the caret: the site (host and
// "/") that the bookmarks and visited pages starting with the text are on, most visited first;
// once the text reaches past the host, the bookmark or visited page that starts with it. Only for
// a single word (a space means search), and only ever an http(s) address. The completed text
// keeps what was typed as it was typed: { text, url }, or null.
const BOOKMARK_WEIGHT = 3;

function inlineCompletion(typed, pages) {
  if (!typed || /\s/.test(typed)) return null;
  const lead = /^(?:https?:\/\/)?(?:www\.)?/i.exec(typed)[0];
  const rest = typed.slice(lead.length).toLowerCase();
  if (!rest) return null;
  const sites = new Map();
  const addresses = new Map();
  let exact = 0; // how much the typed text itself, as a site or an address, is visited
  for (const { url, weight } of pages) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const site = `${host}/`;
    const address = `${host}${parsed.pathname}${parsed.search}`;
    let found = null;
    if (site === rest || address.toLowerCase() === rest) exact += weight;
    if (site.length > rest.length && site.startsWith(rest)) {
      found = sites.get(site) ?? { text: site, url: `${parsed.protocol}//${parsed.host}/`, score: 0 };
      if (parsed.protocol === 'https:') found.url = `https://${parsed.host}/`;
      sites.set(site, found);
    } else if (address.length > rest.length && address.toLowerCase().startsWith(rest)) {
      found = addresses.get(address) ?? { text: address, url, score: 0 };
      addresses.set(address, found);
    }
    if (found) found.score += weight;
  }
  const best = [...(sites.size ? sites : addresses).values()]
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.text.localeCompare(b.text))[0];
  if (!best || exact >= best.score) return null;
  return { text: typed + best.text.slice(rest.length), url: best.url };
}

// What to offer under the address bar: first what the typed text itself does (open the
// address, open a browser page, or search), then matching bookmarks and visited pages.
// With `complete`, a site the text begins (see inlineCompletion) comes first instead, marked
// with the completed text, and what the typed text does on its own comes last.
/**
 * @param {{ text: string, history?: Array<{ url: string, title?: string, visits?: number, lastVisit?: number }>,
 *   bookmarks?: Array<{ url: string, title?: string }>, engine?: string, now?: number, limit?: number, complete?: boolean }} options
 */
function suggest({ text, history = [], bookmarks = [], engine, now = Date.now(), limit = DEFAULT_LIMIT, complete = false }) {
  const typed = String(text ?? '').trim();
  if (!typed) return [];
  const results = [];
  const visits = visitsByUrl(history);
  const titleOf = (url) => bookmarks.find((bookmark) => bookmark.url === url)?.title || visits.find((page) => page.url === url)?.title || '';
  const completion = complete && typed === String(text)
    ? inlineCompletion(typed, [
      ...bookmarks.map((bookmark) => ({ url: bookmark.url, weight: BOOKMARK_WEIGHT })),
      ...visits.map((page) => ({ url: page.url, weight: page.count })),
    ])
    : null;
  const resolved = resolveInput(typed, engine);
  if (resolved.ok && resolved.internal) {
    results.push({ kind: 'page', url: internalUrl(resolved.internal), title: internalUrl(resolved.internal), input: typed });
  } else if (resolved.ok && resolved.searched) {
    results.push({ kind: 'search', url: resolved.url, title: `Search ${engineFor(engine).name} for “${typed}”`, input: typed });
  } else if (resolved.ok) {
    results.push({ kind: 'address', url: resolved.url, title: displayUrl(resolved.url), input: typed });
  }

  const lowered = typed.toLowerCase();
  const words = lowered.split(/\s+/).filter(Boolean);
  const scored = new Map();
  for (const bookmark of bookmarks) {
    const score = matchScore(bookmark, lowered, words);
    if (score) scored.set(bookmark.url, { kind: 'bookmark', url: bookmark.url, title: bookmark.title, score: score + 50 });
  }
  for (const page of visits) {
    const score = matchScore(page, lowered, words);
    if (!score) continue;
    const frequency = 10 * Math.log2(1 + page.count);
    const recency = Math.max(0, 20 - ((now - page.last) / DAY_MS) * 3);
    const existing = scored.get(page.url);
    if (existing) existing.score += frequency + recency;
    else scored.set(page.url, { kind: 'history', url: page.url, title: page.title, score: score + frequency + recency });
  }
  const typedUrl = results[0]?.url;
  const first = completion
    ? [{ kind: 'address', url: completion.url, title: completion.text, note: titleOf(completion.url), completion: completion.text }]
    : results;
  const last = completion && typedUrl !== completion.url ? results : [];
  const matches = [...scored.values()]
    .filter((match) => match.url !== typedUrl && match.url !== completion?.url)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - first.length - last.length))
    .map(({ kind, url, title }) => ({ kind, url, title: title || displayUrl(url) }));
  return [...first, ...matches, ...last];
}

module.exports = { suggest, inlineCompletion, displayUrl };
