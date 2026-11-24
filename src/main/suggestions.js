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

// What to offer under the address bar: first what the typed text itself does (open the
// address, open a browser page, or search), then matching bookmarks and visited pages.
function suggest({ text, history = [], bookmarks = [], engine, now = Date.now(), limit = DEFAULT_LIMIT }) {
  const typed = String(text ?? '').trim();
  if (!typed) return [];
  const results = [];
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
  for (const page of visitsByUrl(history)) {
    const score = matchScore(page, lowered, words);
    if (!score) continue;
    const frequency = 10 * Math.log2(1 + page.count);
    const recency = Math.max(0, 20 - ((now - page.last) / DAY_MS) * 3);
    const existing = scored.get(page.url);
    if (existing) existing.score += frequency + recency;
    else scored.set(page.url, { kind: 'history', url: page.url, title: page.title, score: score + frequency + recency });
  }
  const typedUrl = results[0]?.url;
  const matches = [...scored.values()]
    .filter((match) => match.url !== typedUrl)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit - results.length)
    .map(({ kind, url, title }) => ({ kind, url, title: title || displayUrl(url) }));
  return [...results, ...matches];
}

module.exports = { suggest, displayUrl };
