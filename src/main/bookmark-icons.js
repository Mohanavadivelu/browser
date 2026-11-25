'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUrl } = require('./security/navigation');

// Site icons for bookmarks, by address, kept in their own file in the profile folder so the
// bookmarks themselves stay small. Icons come from visiting a bookmarked page (fetched through
// that tab's own session) or from an imported bookmarks file. Only small images are kept.
const MAX_ICON_LENGTH = 32 * 1024;
const MAX_ICONS = 5000;
const SAVE_DELAY_MS = 1000;
const IMAGE_DATA_URL = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;

function isIcon(value) {
  return typeof value === 'string' && value.length <= MAX_ICON_LENGTH && IMAGE_DATA_URL.test(value);
}

class BookmarkIcons {
  constructor(filePath) {
    this.filePath = filePath;
    this.icons = new Map();
    // Goes up with every change, so the toolbar knows when to ask for icons again.
    this.version = 0;
    this.timer = null;
  }

  load() {
    this.icons = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [url, icon] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (this.icons.size >= MAX_ICONS) break;
        if (isAllowedUrl(url) && isIcon(icon)) this.icons.set(url, icon);
      }
    } catch {
      // No icons yet, or an unreadable file: start empty.
    }
  }

  get(url) {
    return this.icons.get(url) ?? null;
  }

  // Icons for these addresses, as { url: data URL }, leaving out those without one.
  pick(urls) {
    const out = {};
    for (const url of urls) {
      const icon = this.icons.get(url);
      if (icon) out[url] = icon;
    }
    return out;
  }

  // Returns true when the icon was stored (it is new or different, small, and an image).
  set(url, icon) {
    if (!isAllowedUrl(url) || !isIcon(icon) || this.icons.get(url) === icon) return false;
    if (!this.icons.has(url) && this.icons.size >= MAX_ICONS) return false;
    this.icons.set(url, icon);
    this.version += 1;
    this.scheduleSave();
    return true;
  }

  // Forgets icons of addresses that are no longer bookmarked.
  keepOnly(urls) {
    const wanted = new Set(urls);
    let removed = false;
    for (const url of this.icons.keys()) {
      if (!wanted.has(url)) {
        this.icons.delete(url);
        removed = true;
      }
    }
    if (removed) {
      this.version += 1;
      this.scheduleSave();
    }
    return removed;
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
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.icons)));
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.error(`Could not save bookmark icons: ${error.message}`);
    }
  }
}

module.exports = { BookmarkIcons, isIcon, MAX_ICON_LENGTH };
