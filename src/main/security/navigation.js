'use strict';

const SEARCH_URL = 'https://duckduckgo.com/?q=';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_INPUT_LENGTH = 2048;

function isAllowedUrl(value) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function search(text) {
  return { ok: true, url: SEARCH_URL + encodeURIComponent(text), searched: true };
}

// Turns address-bar text into a safe http(s) URL, a search, or a rejection.
function resolveInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'too-long' };
  if (/\s/.test(text)) return search(text);

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
      return search(text);
    }
  }
  return search(text);
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

module.exports = { SEARCH_URL, isAllowedUrl, resolveInput, attachNavigationGuards };
