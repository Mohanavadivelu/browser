'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUrl } = require('../security/navigation');

const MAX_ENTRIES = 5000;
const SAME_PAGE_WINDOW_MS = 30_000;
const SAVE_DELAY_MS = 500;

function withoutFragment(url) {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry.url === 'string' && isAllowedUrl(entry.url) && Number.isFinite(entry.time))
    .slice(-MAX_ENTRIES)
    .map((entry, index) => ({
      id: index + 1,
      url: entry.url,
      title: String(entry.title ?? '').slice(0, 300),
      time: entry.time,
    }));
}

// Browsing history. It only records what it is told to; the caller decides whether history is on.
class History {
  constructor(filePath, { now = Date.now, max = MAX_ENTRIES } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.max = max;
    this.entries = [];
    this.nextId = 1;
    this.timer = null;
  }

  load() {
    try {
      this.entries = sanitizeEntries(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      this.entries = [];
    }
    this.nextId = this.entries.length + 1;
    return this.entries;
  }

  // `inPage` marks a navigation within the same document. One that only changes the #fragment
  // (a jump within the page) is not a new page, so it adds nothing to history.
  add({ url, title = '', inPage = false }) {
    if (!isAllowedUrl(url)) return null;
    const time = this.now();
    const last = this.entries.at(-1);
    if (inPage && last && withoutFragment(last.url) === withoutFragment(url)) return last;
    if (last && last.url === url && time - last.time < SAME_PAGE_WINDOW_MS) {
      last.time = time;
      if (title) last.title = String(title).slice(0, 300);
      this.scheduleSave();
      return last;
    }
    const entry = { id: this.nextId++, url, title: String(title).slice(0, 300), time };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.scheduleSave();
    return entry;
  }

  updateTitle(url, title) {
    for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 5; i--) {
      if (this.entries[i].url === url) {
        this.entries[i].title = String(title).slice(0, 300);
        this.scheduleSave();
        return;
      }
    }
  }

  // Newest first, optionally filtered by text in the title or address.
  list(query = '', limit = 300) {
    const text = String(query).trim().toLowerCase();
    const result = [];
    for (let i = this.entries.length - 1; i >= 0 && result.length < limit; i--) {
      const entry = this.entries[i];
      if (!text || entry.url.toLowerCase().includes(text) || entry.title.toLowerCase().includes(text)) {
        result.push(entry);
      }
    }
    return result;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) this.scheduleSave();
    return this.entries.length !== before;
  }

  clear() {
    this.entries = [];
    this.nextId = 1;
    this.flush();
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.entries));
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.error(`Could not save history: ${error.message}`);
    }
  }
}

module.exports = { History, MAX_ENTRIES };
