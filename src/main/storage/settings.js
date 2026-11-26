'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUrl, SEARCH_ENGINES, DEFAULT_ENGINE } = require('../security/navigation');
const { QUALITY, DEFAULT_QUALITY } = require('../recording/quality');

const { sanitizeTree, find } = require('../bookmarks');
const MAX_ZOOM_SITES = 500;
const MAX_SESSION_TABS = 50;
const ZOOM_RANGE = [0.25, 5];

// Only these keys can be changed from the settings page.
const EDITABLE_KEYS = Object.freeze([
  'homePage', 'searchEngine', 'historyEnabled', 'restoreTabs', 'recordingQuality', 'recordingFollowTab', 'blockTrackers',
  'checkForUpdates', 'recordingStopAfter', 'recordingMicrophone', 'showBookmarksBar', 'downloadsAtOnce', 'resumeDownloads',
]);
const MAX_ALLOWED_SITES = 500;
// Minutes after which a recording stops by itself; 0 is never.
const STOP_AFTER_CHOICES = Object.freeze([0, 5, 10, 15, 30, 45, 60, 90, 120, 180]);
// How many downloads run at once; the rest wait their turn.
const DOWNLOADS_AT_ONCE_CHOICES = Object.freeze([1, 2, 3, 5, 10]);
const DEFAULT_DOWNLOADS_AT_ONCE = 3;
const HOST_NAME = /^[a-z0-9.-]{1,253}$/;

// Sites where the user turned ad and tracker blocking off: plain lower-case host names.
function sanitizeSites(raw) {
  if (!Array.isArray(raw)) return [];
  const sites = raw.filter((site) => typeof site === 'string' && HOST_NAME.test(site));
  return [...new Set(sites)].slice(0, MAX_ALLOWED_SITES);
}

function sanitizeZoom(raw) {
  const zoom = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return zoom;
  for (const [host, factor] of Object.entries(raw)) {
    if (Object.keys(zoom).length >= MAX_ZOOM_SITES) break;
    if (host.length > 253 || typeof factor !== 'number' || !Number.isFinite(factor)) continue;
    if (factor < ZOOM_RANGE[0] || factor > ZOOM_RANGE[1] || factor === 1) continue;
    zoom[host] = factor;
  }
  return zoom;
}

function sanitizeSession(raw) {
  const urls = Array.isArray(raw?.urls)
    ? raw.urls.filter((url) => typeof url === 'string' && isAllowedUrl(url)).slice(0, MAX_SESSION_TABS)
    : [];
  const active = Number.isInteger(raw?.active) && raw.active >= 0 && raw.active < urls.length ? raw.active : 0;
  return { urls, active };
}

function sanitizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  // A tree of folders; the flat list of earlier versions becomes the Bookmarks bar.
  const bookmarks = sanitizeTree(source.bookmarks);
  const lastFolder = typeof source.bookmarkFolder === 'string' ? find(bookmarks, source.bookmarkFolder) : null;
  return {
    bookmarks,
    // Where the star puts a new bookmark: the folder used last.
    bookmarkFolder: lastFolder?.node.type === 'folder' ? lastFolder.node.id : 'bar',
    recordingFolder: typeof source.recordingFolder === 'string' && path.isAbsolute(source.recordingFolder)
      ? source.recordingFolder
      : null,
    homePage: typeof source.homePage === 'string' && isAllowedUrl(source.homePage.trim())
      ? new URL(source.homePage.trim()).href
      : '',
    searchEngine: Object.hasOwn(SEARCH_ENGINES, source.searchEngine) ? source.searchEngine : DEFAULT_ENGINE,
    historyEnabled: source.historyEnabled === true,
    restoreTabs: source.restoreTabs === true,
    recordingQuality: Object.hasOwn(QUALITY, source.recordingQuality) ? source.recordingQuality : DEFAULT_QUALITY,
    recordingFollowTab: source.recordingFollowTab !== false,
    recordingMicrophone: source.recordingMicrophone === true,
    showBookmarksBar: source.showBookmarksBar !== false,
    recordingStopAfter: STOP_AFTER_CHOICES.includes(source.recordingStopAfter) ? source.recordingStopAfter : 0,
    blockTrackers: source.blockTrackers !== false,
    checkForUpdates: source.checkForUpdates !== false,
    downloadsAtOnce: DOWNLOADS_AT_ONCE_CHOICES.includes(source.downloadsAtOnce) ? source.downloadsAtOnce : DEFAULT_DOWNLOADS_AT_ONCE,
    resumeDownloads: source.resumeDownloads !== false,
    blockerAllowedSites: sanitizeSites(source.blockerAllowedSites),
    zoom: sanitizeZoom(source.zoom),
    session: sanitizeSession(source.session),
  };
}

// Keeps only the fields the settings page may change.
function pickEditable(partial) {
  const picked = {};
  if (partial === null || typeof partial !== 'object') return picked;
  for (const key of EDITABLE_KEYS) {
    if (Object.hasOwn(partial, key)) picked[key] = partial[key];
  }
  return picked;
}

// Settings live in the user's profile folder as JSON.
class Settings {
  // `onSaveError(error)` hears about a save that failed (a full or read-only disk); the change
  // still applies for this session.
  constructor(filePath, { onSaveError } = {}) {
    this.filePath = filePath;
    this.data = sanitizeSettings(null);
    this.onSaveError = onSaveError ?? null;
    this.saveError = null;
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
    const temporary = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2));
      fs.renameSync(temporary, this.filePath);
      this.saveError = null;
    } catch (error) {
      this.saveError = error;
      console.error(`Could not save settings: ${error.message}`);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do.
      }
      this.onSaveError?.(error);
    }
    return this.data;
  }
}

module.exports = { Settings, sanitizeSettings, pickEditable, EDITABLE_KEYS, STOP_AFTER_CHOICES, DOWNLOADS_AT_ONCE_CHOICES };
