'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cookieUrl, SITE_STORAGE } = require('./site-info');

// Clear browsing data, over a time range: history, cookies and site data, the cache, and the
// downloads list (the files stay). Bookmarks, settings and recordings are never touched, and
// private tabs keep nothing to clear. Only the regular profile's session is cleared.
//
// Electron can't tell when a cookie was set, so the browser keeps that itself (CookieClock):
// clearing a time range removes the cookies set in it, and everything else the sites that set
// them stored. The cache can only be emptied whole.
const RANGES = Object.freeze({
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 28 * 24 * 60 * 60 * 1000,
  all: Infinity,
});
const MAX_COOKIES = 20000;
const SAVE_DELAY_MS = 2000;

const cookieKey = (cookie) => `${String(cookie.domain).toLowerCase()}\t${cookie.path || '/'}\t${cookie.name}`;

// When each cookie of the regular profile was first set, kept in the profile.
class CookieClock {
  constructor({ filePath = null, now = Date.now } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.times = new Map();
    this.timer = null;
  }

  load() {
    if (!this.filePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [key, time] of Object.entries(saved?.times ?? {})) {
        if (typeof key === 'string' && key.length < 4200 && Number.isFinite(time) && time > 0) this.times.set(key, time);
        if (this.times.size >= MAX_COOKIES) break;
      }
    } catch {
      // No times yet: every cookie already there counts as older than any range.
    }
  }

  // Listens to a session's cookie changes. A cookie only overwritten keeps its first time.
  attach(session) {
    session.cookies.on('changed', (_event, cookie, cause, removed) => {
      if (removed) {
        if (cause !== 'overwrite') this.forget(cookie);
      } else {
        this.seen(cookie);
      }
    });
  }

  seen(cookie, time = this.now()) {
    const key = cookieKey(cookie);
    if (this.times.has(key)) return;
    if (this.times.size >= MAX_COOKIES) this.times.delete(this.times.keys().next().value);
    this.times.set(key, time);
    this.scheduleSave();
  }

  forget(cookie) {
    if (this.times.delete(cookieKey(cookie))) this.scheduleSave();
  }

  // When the cookie was set; 0 for one set before the browser kept times.
  firstSeen(cookie) {
    return this.times.get(cookieKey(cookie)) ?? 0;
  }

  scheduleSave() {
    if (!this.filePath || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  save() {
    if (!this.filePath) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, times: Object.fromEntries(this.times) }));
    } catch (error) {
      console.error(`Could not save cookie times: ${error.message}`);
    }
  }
}

function sinceFor(range, now) {
  const span = RANGES[range];
  if (span === undefined) throw new Error(`Unknown range: ${range}`);
  return span === Infinity ? 0 : now - span;
}

const siteOf = (cookie) => String(cookie.domain).replace(/^\./, '').toLowerCase();

// The cookies a clear would remove: all of them, or those set in the range.
async function cookiesInRange(session, clock, since) {
  const cookies = await session.cookies.get({});
  return since === 0 ? cookies : cookies.filter((cookie) => clock.firstSeen(cookie) >= since);
}

// What a clear of `range` would remove, for the dialog.
async function clearSummary({ range, history, downloads, session, clock, now = Date.now() }) {
  const since = sinceFor(range, now);
  const cookies = await cookiesInRange(session, clock, since);
  return {
    range,
    history: history.countSince(since),
    cookies: cookies.length,
    cookieSites: new Set(cookies.map(siteOf)).size,
    cacheBytes: await session.getCacheSize().catch(() => 0),
    downloads: downloads.countFinishedSince(since),
  };
}

// Clears what `what` asks for ({ history, cookies, cache, downloads }) over `range`.
async function clearBrowsingData({ range, what, history, downloads, session, clock, now = Date.now() }) {
  const since = sinceFor(range, now);
  const done = { range, history: 0, cookies: 0, cookieSites: 0, cacheBytes: 0, downloads: 0 };
  if (what.history) done.history = history.removeSince(since);
  if (what.downloads) done.downloads = downloads.removeFinishedSince(since);
  if (what.cookies) {
    const cookies = await cookiesInRange(session, clock, since);
    done.cookies = cookies.length;
    done.cookieSites = new Set(cookies.map(siteOf)).size;
    if (since === 0) {
      // Everything the sites keep, cookies included (the cache is its own choice).
      await session.clearStorageData({ storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] });
      for (const cookie of cookies) clock.forget(cookie);
    } else {
      for (const cookie of cookies) {
        await session.cookies.remove(cookieUrl(cookie), cookie.name).catch(() => {});
        clock.forget(cookie);
      }
      // And what those sites stored, under both schemes.
      const origins = [...new Set(cookies.map(siteOf))].flatMap((site) => [`https://${site}`, `http://${site}`]);
      if (origins.length) await session.clearData({ origins, dataTypes: [...SITE_STORAGE] });
    }
    clock.save();
  }
  if (what.cache) {
    done.cacheBytes = await session.getCacheSize().catch(() => 0);
    await session.clearCache();
  }
  return done;
}

module.exports = { CookieClock, RANGES, sinceFor, clearSummary, clearBrowsingData, cookieKey };
