'use strict';

const SEARCH_ENGINES = Object.freeze({
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
});
const DEFAULT_ENGINE = 'google';
const INTERNAL_PAGES = Object.freeze(['history', 'bookmarks', 'downloads', 'recordings', 'settings']);
const INTERNAL_SCHEME = 'simple-browser:';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_INPUT_LENGTH = 2048;

function isAllowedUrl(value) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function engineFor(key) {
  return SEARCH_ENGINES[key] ?? SEARCH_ENGINES[DEFAULT_ENGINE];
}

function internalUrl(page) {
  return `${INTERNAL_SCHEME}//${page}`;
}

function search(text, engine) {
  return { ok: true, url: engineFor(engine).url + encodeURIComponent(text), searched: true };
}

// Turns address-bar text into a safe http(s) URL, an internal page, a search, or a rejection.
function resolveInput(raw, engine = DEFAULT_ENGINE) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'too-long' };

  const internal = /^simple-browser:\/\/([a-z]+)\/?$/i.exec(text);
  if (internal && INTERNAL_PAGES.includes(internal[1].toLowerCase())) {
    return { ok: true, internal: internal[1].toLowerCase() };
  }
  if (/\s/.test(text)) return search(text, engine);

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  const isHostAndPort = /^[^\s/:]+:\d+(\/|\?|#|$)/.test(text);
  if (hasScheme && !isHostAndPort) {
    return isAllowedUrl(text)
      ? { ok: true, url: new URL(text).href }
      : { ok: false, reason: 'blocked-scheme' };
  }

  const looksLikeHost = /^(localhost|(\d{1,3}\.){3}\d{1,3}|[^\s/.]+(\.[^\s/.]+)+)(:\d+)?([/?#].*)?$/i.test(text);
  if (looksLikeHost) {
    try {
      return { ok: true, url: new URL('https://' + text).href };
    } catch {
      return search(text, engine);
    }
  }
  return search(text, engine);
}

// Applies to tab content only: page-initiated navigation must stay on http(s).
function attachNavigationGuards(contents, { openInNewTab, onBlocked }) {
  const guard = (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      onBlocked?.(url);
    }
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) openInNewTab(url);
    else onBlocked?.(url);
    return { action: 'deny' };
  });
}

module.exports = {
  SEARCH_ENGINES, DEFAULT_ENGINE, INTERNAL_PAGES, engineFor, internalUrl,
  isAllowedUrl, resolveInput, attachNavigationGuards,
};
