'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FiltersEngine, Request, parseFilters } = require('@ghostery/adblocker');

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
// Requests caught by a filter from one of these lists are trackers; the rest are ads.
const TRACKER_LISTS = new Set(['https://easylist.to/easylist/easyprivacy.txt']);
const CACHE_FORMAT = 2;
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

function buildEngine({ ad = '', tracker = '' }) {
  // One engine holds both lists, so an exception in one still applies to a filter from the other.
  const engine = FiltersEngine.parse(`${ad}\n${tracker}`, { loadCosmeticFilters: false, loadNetworkFilters: true });
  const trackerIds = new Set(parseFilters(tracker, { loadCosmeticFilters: false }).networkFilters.map((filter) => filter.getId()));
  return { engine, trackerIds };
}

class ContentBlocker {
  // fetchText(url) returns a list's text; `cacheDir` holds the compiled lists.
  constructor({ cacheDir, fetchText, lists = DEFAULT_LISTS, now = Date.now }) {
    this.cacheDir = cacheDir;
    this.fetchText = fetchText;
    this.lists = lists;
    this.now = now;
    this.engine = null;
    this.trackerIds = new Set(); // ids of the filters that come from a tracker list
    this.updatedAt = 0;
    this.updating = null;
  }

  get ready() {
    return this.engine !== null;
  }

  get enginePath() {
    return path.join(this.cacheDir, 'filters.bin');
  }

  get trackersPath() {
    return path.join(this.cacheDir, 'trackers.bin');
  }

  get metaPath() {
    return path.join(this.cacheDir, 'filters.json');
  }

  // Builds the engine from filter text directly (used by tests): a string of ad filters, or
  // { ad, tracker } to say which filters catch trackers.
  useFilters(filters) {
    Object.assign(this, buildEngine(typeof filters === 'string' ? { ad: filters } : filters));
    return this.engine;
  }

  // Loads the compiled lists saved by an earlier update. A cache from another library version
  // or format, or a damaged one, is ignored and the lists are downloaded again.
  loadCache() {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (meta.format !== CACHE_FORMAT || JSON.stringify(meta.lists) !== JSON.stringify(this.lists)) return false;
      const ids = fs.readFileSync(this.trackersPath);
      const trackerIds = new Set(new Uint32Array(ids.buffer.slice(ids.byteOffset, ids.byteOffset + ids.length - (ids.length % 4))));
      this.engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(this.enginePath)));
      this.trackerIds = trackerIds;
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
        const texts = { ad: [], tracker: [] };
        for (const url of this.lists) {
          const text = await this.fetchText(url);
          if (typeof text !== 'string' || text.length === 0 || text.length > MAX_LIST_BYTES) {
            throw new Error(`unexpected list from ${url}`);
          }
          texts[TRACKER_LISTS.has(url) ? 'tracker' : 'ad'].push(text);
        }
        const built = buildEngine({ ad: texts.ad.join('\n'), tracker: texts.tracker.join('\n') });
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(this.enginePath, built.engine.serialize());
        fs.writeFileSync(this.trackersPath, Buffer.from(Uint32Array.from(built.trackerIds).buffer));
        this.updatedAt = this.now();
        fs.writeFileSync(this.metaPath, JSON.stringify({ format: CACHE_FORMAT, updatedAt: this.updatedAt, lists: this.lists }));
        Object.assign(this, built);
        return true;
      } finally {
        this.updating = null;
      }
    })();
    return this.updating;
  }

  // What blocks a request: 'ad' or 'tracker' (by the list its filter came from), or null to let
  // it through. The page itself (main frame) is never blocked.
  classify({ url, resourceType, pageUrl }) {
    if (!this.engine || resourceType === 'mainFrame') return null;
    if (!/^(https?|wss?):/i.test(url)) return null;
    const type = REQUEST_TYPES[resourceType] ?? 'other';
    const { match, filter } = this.engine.match(Request.fromRawDetails({ url, sourceUrl: pageUrl || url, type }));
    if (!match) return null;
    return filter && this.trackerIds.has(filter.getId()) ? 'tracker' : 'ad';
  }

  // Whether a request should be blocked.
  shouldBlock(details) {
    return this.classify(details) !== null;
  }

  // Blocks matching requests in a session. `isActive(pageUrl)` says whether blocking is on for
  // that page (the setting, and sites the user allowed); `onBlocked(webContentsId, request)`
  // records it, with the request's url, resourceType and kind ('ad' or 'tracker').
  attach(session, { pageUrlOf, isActive, onBlocked }) {
    session.webRequest.onBeforeRequest((details, callback) => {
      let kind = null;
      try {
        const pageUrl = pageUrlOf(details) || details.referrer || '';
        if (isActive(pageUrl)) kind = this.classify({ url: details.url, resourceType: details.resourceType, pageUrl });
      } catch {
        kind = null;
      }
      callback({ cancel: kind !== null });
      // Counting it for the tab's shield must never get in the way of blocking it.
      if (kind) {
        try {
          onBlocked(details.webContentsId, { url: details.url, resourceType: details.resourceType, kind });
        } catch (error) {
          console.error(`Could not count a blocked request: ${error.message}`);
        }
      }
    });
  }
}

// What a tab blocked since its page loaded, by the host each request went to. It keeps at most
// MAX_HOSTS hosts and MAX_ADDRESSES addresses per host; the counts keep going past that.
const MAX_HOSTS = 100;
const MAX_ADDRESSES = 20;
const MAX_ADDRESS_LENGTH = 200;
const TYPE_NAMES = Object.freeze({
  subFrame: 'frame', stylesheet: 'style', script: 'script', image: 'image', font: 'font', object: 'plugin',
  xhr: 'request', ping: 'ping', cspReport: 'report', media: 'media', webSocket: 'socket',
});

class BlockedLog {
  constructor() {
    this.hosts = new Map();
    this.total = 0;
  }

  clear() {
    this.hosts.clear();
    this.total = 0;
  }

  add({ url, resourceType, kind }) {
    this.total += 1;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const host = parsed.hostname.toLowerCase();
    let entry = this.hosts.get(host);
    if (!entry) {
      if (this.hosts.size >= MAX_HOSTS) return;
      entry = { host, kind: kind === 'tracker' ? 'tracker' : 'ad', count: 0, addresses: [] };
      this.hosts.set(host, entry);
    }
    entry.count += 1;
    if (kind !== 'tracker') entry.kind = 'ad'; // a host that served any ad is shown as an ad host
    if (entry.addresses.length < MAX_ADDRESSES) {
      const address = `${parsed.pathname}${parsed.search}`.slice(0, MAX_ADDRESS_LENGTH);
      entry.addresses.push({ path: address, type: TYPE_NAMES[resourceType] ?? 'other' });
    }
  }

  // Hosts with the most blocked requests first.
  summary() {
    return [...this.hosts.values()]
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
      .map((entry) => ({ ...entry, addresses: entry.addresses.map((address) => ({ ...address })) }));
  }
}

module.exports = { ContentBlocker, BlockedLog, DEFAULT_LISTS, REFRESH_AFTER_MS, MAX_HOSTS, MAX_ADDRESSES, hostOf };
