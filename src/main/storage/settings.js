'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUrl, SEARCH_ENGINES, DEFAULT_ENGINE } = require('../security/navigation');
const { QUALITY, DEFAULT_QUALITY } = require('../recording/quality');

const MAX_BOOKMARKS = 1000;
const MAX_ZOOM_SITES = 500;
const MAX_SESSION_TABS = 50;
const ZOOM_RANGE = [0.25, 5];

// Only these keys can be changed from the settings page.
const EDITABLE_KEYS = Object.freeze([
  'homePage', 'searchEngine', 'historyEnabled', 'restoreTabs', 'recordingQuality', 'recordingFollowTab', 'blockTrackers',
  'checkForUpdates', 'recordingStopAfter', 'recordingMicrophone',
]);
const MAX_ALLOWED_SITES = 500;
// Minutes after which a recording stops by itself; 0 is never.
const STOP_AFTER_CHOICES = Object.freeze([0, 5, 10, 15, 30, 45, 60, 90, 120, 180]);
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
  const bookmarks = Array.isArray(source.bookmarks) ? source.bookmarks : [];
  return {
    bookmarks: bookmarks
      .filter((b) => b && typeof b.url === 'string' && isAllowedUrl(b.url))
      .slice(0, MAX_BOOKMARKS)
      .map((b) => ({ url: b.url, title: String(b.title ?? b.url).slice(0, 200) })),
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
    recordingStopAfter: STOP_AFTER_CHOICES.includes(source.recordingStopAfter) ? source.recordingStopAfter : 0,
    blockTrackers: source.blockTrackers !== false,
    checkForUpdates: source.checkForUpdates !== false,
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

module.exports = { Settings, sanitizeSettings, pickEditable, EDITABLE_KEYS, MAX_BOOKMARKS, STOP_AFTER_CHOICES };
