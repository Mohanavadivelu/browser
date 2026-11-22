'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUrl } = require('../security/navigation');

const MAX_BOOKMARKS = 200;

function sanitizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const bookmarks = Array.isArray(source.bookmarks) ? source.bookmarks : [];
  return {
    bookmarks: bookmarks
      .filter((b) => b && typeof b.url === 'string' && isAllowedUrl(b.url))
      .slice(0, MAX_BOOKMARKS)
      .map((b) => ({ url: b.url, title: String(b.title ?? b.url).slice(0, 200) })),
    recordingFolder: typeof source.recordingFolder === 'string' && path.isAbsolute(source.recordingFolder)
      ? source.recordingFolder
      : null,
  };
}

// Settings live in the user's profile folder as JSON; no history is stored anywhere.
class Settings {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = sanitizeSettings(null);
  }

  load() {
    try {
      this.data = sanitizeSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      this.data = sanitizeSettings(null);
    }
    return this.data;
  }

  update(partial) {
    this.data = sanitizeSettings({ ...this.data, ...partial });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
    fs.renameSync(temporary, this.filePath);
    return this.data;
  }
}

module.exports = { Settings, sanitizeSettings };
