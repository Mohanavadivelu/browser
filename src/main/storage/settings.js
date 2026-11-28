'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUrl, SEARCH_ENGINES, DEFAULT_ENGINE } = require('../security/navigation');
const { QUALITY, DEFAULT_QUALITY } = require('../recording/quality');

const { sanitizeTree, find } = require('../bookmarks');
const { sanitizeSplits } = require('../split-view');
const MAX_ZOOM_SITES = 500;
const MAX_SESSION_TABS = 50;
const ZOOM_RANGE = [0.25, 5];

// Only these keys can be changed from the settings page.
const EDITABLE_KEYS = Object.freeze([
  'homePage', 'searchEngine', 'historyEnabled', 'restoreTabs', 'recordingQuality', 'recordingFollowTab', 'blockTrackers',
  'checkForUpdates', 'recordingStopAfter', 'recordingMicrophone', 'showBookmarksBar', 'downloadsAtOnce', 'resumeDownloads',
  'connectionsPerFile', 'speedLimitKBps', 'markOfTheWeb', 'downloadNightOnly', 'downloadNightFrom', 'downloadNightTo',
  'memorySaverMinutes', 'spellcheck', 'darkPages',
]);
// Tab groups' colours (see tabs.js), and how long a tab may stay in the background before the
// memory saver puts it to sleep (0: never).
const GROUP_COLORS = Object.freeze(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan']);
const MEMORY_SAVER_CHOICES = Object.freeze([0, 15, 30, 60, 120, 240]);
const DEFAULT_MEMORY_SAVER = 30;
const MAX_PINNED = 20;
const MAX_GROUPS = 50;
const MAX_ALLOWED_SITES = 500;
// Minutes after which a recording stops by itself; 0 is never.
const STOP_AFTER_CHOICES = Object.freeze([0, 5, 10, 15, 30, 45, 60, 90, 120, 180]);
// How many downloads run at once; the rest wait their turn.
const DOWNLOADS_AT_ONCE_CHOICES = Object.freeze([1, 2, 3, 5, 10]);
const DEFAULT_DOWNLOADS_AT_ONCE = 3;
// How many connections a big download may use at once (1: never split).
const CONNECTIONS_CHOICES = Object.freeze([1, 2, 4, 8, 16]);
const DEFAULT_CONNECTIONS = 8;
// The speed limit for all downloads together, in KB a second (0: none).
const MAX_SPEED_LIMIT_KBPS = 10 * 1024 * 1024;
// When downloads added to the queue may start, if only at night: minutes after midnight.
const minutesOfDay = (value, fallback) => (Number.isInteger(value) && value >= 0 && value < 24 * 60 ? value : fallback);
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

// The saved tabs, and their groups ({ name, color, collapsed, tabs: places in `urls` }). An
// address that isn't kept moves the places after it, so the groups follow.
function sanitizeSession(raw) {
  const urls = [];
  const placeOf = new Map(); // place in the saved list -> place in `urls`
  if (Array.isArray(raw?.urls)) {
    raw.urls.forEach((url, index) => {
      if (urls.length >= MAX_SESSION_TABS || typeof url !== 'string' || !isAllowedUrl(url)) return;
      placeOf.set(index, urls.length);
      urls.push(url);
    });
  }
  const savedActive = Number.isInteger(raw?.active) ? placeOf.get(raw.active) : undefined;
  const active = savedActive ?? 0;
  const taken = new Set();
  const groups = [];
  for (const group of Array.isArray(raw?.groups) ? raw.groups.slice(0, MAX_GROUPS) : []) {
    if (group === null || typeof group !== 'object' || !Array.isArray(group.tabs)) continue;
    const tabs = group.tabs.map((index) => placeOf.get(index)).filter((place) => place !== undefined && !taken.has(place));
    if (tabs.length === 0) continue;
    for (const place of tabs) taken.add(place);
    groups.push({
      name: typeof group.name === 'string' ? group.name.slice(0, 60) : '',
      color: GROUP_COLORS.includes(group.color) ? group.color : 'grey',
      collapsed: group.collapsed === true,
      tabs,
    });
  }
  // Split tabs: two places side by side, with the left side's share of the width.
  const splits = sanitizeSplits(raw?.splits, placeOf);
  return { urls, active, groups, splits };
}

// Pinned tabs, kept for every start whatever the restore setting: http(s) addresses.
function sanitizePinned(raw) {
  return Array.isArray(raw) ? raw.filter((url) => typeof url === 'string' && isAllowedUrl(url)).slice(0, MAX_PINNED) : [];
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
    connectionsPerFile: CONNECTIONS_CHOICES.includes(source.connectionsPerFile) ? source.connectionsPerFile : DEFAULT_CONNECTIONS,
    speedLimitKBps: Number.isSafeInteger(source.speedLimitKBps) && source.speedLimitKBps > 0 && source.speedLimitKBps <= MAX_SPEED_LIMIT_KBPS ? source.speedLimitKBps : 0,
    markOfTheWeb: source.markOfTheWeb !== false,
    downloadNightOnly: source.downloadNightOnly === true,
    downloadNightFrom: minutesOfDay(source.downloadNightFrom, 60),
    downloadNightTo: minutesOfDay(source.downloadNightTo, 7 * 60),
    blockerAllowedSites: sanitizeSites(source.blockerAllowedSites),
    zoom: sanitizeZoom(source.zoom),
    session: sanitizeSession(source.session),
    pinnedTabs: sanitizePinned(source.pinnedTabs),
    // Spell checking in the text boxes of web pages; dark pages, and the sites kept light; the
    // new tab page's tiles the user removed.
    spellcheck: source.spellcheck !== false,
    darkPages: source.darkPages === true,
    darkPagesLight: sanitizeSites(source.darkPagesLight),
    newTabHidden: Array.isArray(source.newTabHidden)
      ? [...new Set(source.newTabHidden.filter((url) => typeof url === 'string' && url.length <= 400 && isAllowedUrl(url)))].slice(-200)
      : [],
    memorySaverMinutes: MEMORY_SAVER_CHOICES.includes(source.memorySaverMinutes) ? source.memorySaverMinutes : DEFAULT_MEMORY_SAVER,
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

module.exports = {
  Settings, sanitizeSettings, pickEditable, EDITABLE_KEYS, STOP_AFTER_CHOICES, DOWNLOADS_AT_ONCE_CHOICES, CONNECTIONS_CHOICES,
  GROUP_COLORS, MEMORY_SAVER_CHOICES,
};
