'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FiltersEngine, Request } = require('@ghostery/adblocker');

// Blocks requests for ads and trackers in web tabs, using the EasyList and EasyPrivacy filter
// lists. Only network requests are blocked: nothing is injected into pages (web pages get no
// preload script in this browser), so element-hiding rules are not used.
//
// The lists are downloaded by the browser itself and kept, already compiled, in the profile
// folder. They are refreshed when they are older than REFRESH_AFTER_MS.
const DEFAULT_LISTS = Object.freeze([
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
]);
const REFRESH_AFTER_MS = 4 * 24 * 60 * 60 * 1000;
const MAX_LIST_BYTES = 20 * 1024 * 1024;

// Electron's resource types, in the names the filter lists use.
const REQUEST_TYPES = Object.freeze({
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
});

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

class ContentBlocker {
  // fetchText(url) returns a list's text; `cacheDir` holds the compiled lists.
  constructor({ cacheDir, fetchText, lists = DEFAULT_LISTS, now = Date.now }) {
    this.cacheDir = cacheDir;
    this.fetchText = fetchText;
    this.lists = lists;
    this.now = now;
    this.engine = null;
    this.updatedAt = 0;
    this.updating = null;
  }

  get ready() {
    return this.engine !== null;
  }

  get enginePath() {
    return path.join(this.cacheDir, 'filters.bin');
  }

  get metaPath() {
    return path.join(this.cacheDir, 'filters.json');
  }

  // Builds the engine from filter text directly (used by tests, and by update()).
  useFilters(text) {
    this.engine = FiltersEngine.parse(text, { loadCosmeticFilters: false, loadNetworkFilters: true });
    return this.engine;
  }

  // Loads the compiled lists saved by an earlier update. A cache from another library version,
  // or a damaged one, is ignored and the lists are downloaded again.
  loadCache() {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (JSON.stringify(meta.lists) !== JSON.stringify(this.lists)) return false;
      this.engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(this.enginePath)));
      this.updatedAt = Number(meta.updatedAt) || 0;
      return true;
    } catch {
      return false;
    }
  }

  get stale() {
    return !this.ready || this.now() - this.updatedAt > REFRESH_AFTER_MS;
  }

  // Downloads and compiles the lists, then saves them. Concurrent calls share one download.
  update() {
    this.updating ??= (async () => {
      try {
        const texts = [];
        for (const url of this.lists) {
          const text = await this.fetchText(url);
          if (typeof text !== 'string' || text.length === 0 || text.length > MAX_LIST_BYTES) {
            throw new Error(`unexpected list from ${url}`);
          }
          texts.push(text);
        }
        const engine = FiltersEngine.parse(texts.join('\n'), { loadCosmeticFilters: false, loadNetworkFilters: true });
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(this.enginePath, engine.serialize());
        this.updatedAt = this.now();
        fs.writeFileSync(this.metaPath, JSON.stringify({ updatedAt: this.updatedAt, lists: this.lists }));
        this.engine = engine;
        return true;
      } finally {
        this.updating = null;
      }
    })();
    return this.updating;
  }

  // Whether a request should be blocked. The page itself (main frame) is never blocked.
  shouldBlock({ url, resourceType, pageUrl }) {
    if (!this.engine || resourceType === 'mainFrame') return false;
    if (!/^(https?|wss?):/i.test(url)) return false;
    const type = REQUEST_TYPES[resourceType] ?? 'other';
    const { match } = this.engine.match(Request.fromRawDetails({ url, sourceUrl: pageUrl || url, type }));
    return match;
  }

  // Blocks matching requests in a session. `isActive(pageUrl)` says whether blocking is on for
  // that page (the setting, and sites the user allowed); `onBlocked(webContentsId)` counts.
  attach(session, { pageUrlOf, isActive, onBlocked }) {
    session.webRequest.onBeforeRequest((details, callback) => {
      let cancel = false;
      try {
        const pageUrl = pageUrlOf(details) || details.referrer || '';
        cancel = isActive(pageUrl) && this.shouldBlock({ url: details.url, resourceType: details.resourceType, pageUrl });
      } catch {
        cancel = false;
      }
      if (cancel) onBlocked(details.webContentsId);
      callback({ cancel });
    });
  }
}

module.exports = { ContentBlocker, DEFAULT_LISTS, REFRESH_AFTER_MS, hostOf };
