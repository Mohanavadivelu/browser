'use strict';

const { sanitizeSettings, pickEditable } = require('./storage/settings');
const { sanitizeEntry } = require('./download-manager');
const { isAllowedUrl } = require('./security/navigation');
const bookmarkTree = require('./bookmarks');

// Back up and restore: one file with the bookmarks, the settings, the pinned tabs, the list of
// finished downloads and, if asked, the history. Never cookies, site data, recordings or private
// tabs. A file being restored is checked as strictly as the browser's own files are, and the
// user chooses which parts to restore.
const FORMAT = 'simple-browser-backup';
const VERSION = 1;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY = 5000;
// Settings that make sense on another computer (not folders, or the saved session).
const EXTRA_SETTINGS = Object.freeze(['blockerAllowedSites', 'darkPagesLight', 'newTabHidden']);

function createBackup({ settings, history, downloads, includeHistory, appVersion, now = Date.now() }) {
  const kept = pickEditable(settings);
  for (const key of EXTRA_SETTINGS) kept[key] = settings[key];
  return {
    format: FORMAT,
    version: VERSION,
    appVersion,
    createdAt: now,
    bookmarks: settings.bookmarks,
    settings: kept,
    pinnedTabs: settings.pinnedTabs,
    downloads: downloads.exportEntries(),
    history: includeHistory ? history.entries.map(({ url, title, time }) => ({ url, title, time })) : null,
  };
}

const counts = (backup) => ({
  bookmarks: bookmarkTree.links(backup.bookmarks).length,
  // The bookmarks bar and Other bookmarks are always there.
  folders: bookmarkTree.folders(backup.bookmarks).filter((folder) => folder.depth > 0).length,
  settings: Object.keys(backup.settings).length,
  pinnedTabs: backup.pinnedTabs.length,
  downloads: backup.downloads.length,
  history: backup.history ? backup.history.length : null,
});

// Reads a backup file's text: { ok: true, backup, counts } with everything checked, or
// { ok: false, reason }.
function parseBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) return { ok: false, reason: 'too-large' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (raw?.format !== FORMAT) return { ok: false, reason: 'not-a-backup' };
  if (raw.version !== VERSION) return { ok: false, reason: 'newer-version' };
  // The same checks as the browser's own settings file.
  const clean = sanitizeSettings({ ...(raw.settings ?? {}), bookmarks: raw.bookmarks, pinnedTabs: raw.pinnedTabs });
  const settings = pickEditable(clean);
  for (const key of EXTRA_SETTINGS) settings[key] = clean[key];
  const downloads = (Array.isArray(raw.downloads) ? raw.downloads : []).map(sanitizeEntry).filter(Boolean)
    .filter((entry) => ['completed', 'cancelled', 'interrupted'].includes(entry.state)).slice(0, 100);
  const history = Array.isArray(raw.history)
    ? raw.history
      .filter((entry) => entry && typeof entry.url === 'string' && isAllowedUrl(entry.url) && Number.isFinite(entry.time) && entry.time > 0)
      .slice(-MAX_HISTORY)
      .map((entry) => ({ url: entry.url, title: String(entry.title ?? '').slice(0, 300), time: entry.time }))
    : null;
  const backup = {
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion.slice(0, 40) : '',
    bookmarks: clean.bookmarks,
    settings,
    pinnedTabs: clean.pinnedTabs,
    downloads,
    history,
  };
  return { ok: true, backup, counts: counts(backup) };
}

// Restores the parts chosen ({ bookmarks, settings, pinnedTabs, downloads, history }). Bookmarks
// and settings replace what is there; downloads and history are added to it, and the pinned tabs
// not already open are opened (`openPinned(urls)` returns how many).
function restoreBackup(backup, parts, { settings, history, downloads, openPinned }) {
  const done = {};
  const patch = {};
  if (parts.bookmarks) {
    patch.bookmarks = backup.bookmarks;
    done.bookmarks = bookmarkTree.links(backup.bookmarks).length;
  }
  if (parts.settings) {
    Object.assign(patch, backup.settings);
    done.settings = Object.keys(backup.settings).length;
  }
  if (Object.keys(patch).length) settings.update(patch);
  if (parts.pinnedTabs) done.pinnedTabs = openPinned(backup.pinnedTabs);
  if (parts.downloads) done.downloads = downloads.importEntries(backup.downloads);
  if (parts.history && backup.history) done.history = history.importEntries(backup.history);
  return done;
}

module.exports = { createBackup, parseBackup, restoreBackup, FORMAT, VERSION, MAX_BYTES };
